/**
 * OpenHive Backend - Team SDK Tool Handlers
 *
 * Registers team management tool handlers on the ToolHandler.
 * Covers agent creation, team creation/deletion, and team queries.
 * Implements the two-step creation pattern: create_agent first (which
 * adds the lead agent to the parent team config), then create_team
 * (which validates the leader exists in OrgChart and creates the team).
 */

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, rm, unlink } from 'node:fs/promises';
import { join as pathJoin } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { ConfigLoader, OrgChart, EventBus, KeyManager, TaskStore, ContainerManager, WSHub, SkillRegistry } from '../domain/interfaces.js';
import type { JsonValue, Agent, Team, ContainerConfig, SystemLimits } from '../domain/types.js';
import { ValidationError, ConflictError, NotFoundError } from '../domain/errors.js';
import { validateSlug, validateAID, isReservedSlug, slugifyName } from '../domain/validation.js';
import { validateModelTier } from '../domain/enums.js';
import type { ToolFunc, ToolCallContext } from './toolhandler.js';
import type { ToolRegistry } from '../domain/interfaces.js';
import { scaffoldTeamWorkspace, validateWorkspacePath, resolveTeamWorkspacePath } from './orchestrator.js';
import { SkillLoader, validateSkillName } from './skills.js';
import { encodeMessage, MsgTypeAgentAdded } from '../ws/index.js';
import type { AgentInitConfig, ProviderConfig } from '../ws/messages.js';

// ---------------------------------------------------------------------------
// TeamToolsDeps
// ---------------------------------------------------------------------------

/**
 * Dependencies injected into team tool handlers.
 */
export interface TeamToolsDeps {
  configLoader: ConfigLoader;
  orgChart: OrgChart;
  eventBus: EventBus | null;
  keyManager: KeyManager;
  taskStore: TaskStore;
  runDir: string;
  /** Path to main-assistant/.claude/skills/ for copying into team workspaces. */
  skillsSourceDir?: string;
  /** Container manager for provisioning team containers. Null in tests/no-docker. */
  containerManager: ContainerManager | null;
  /** WebSocket hub for sending messages to team containers. Null in tests. */
  wsHub: WSHub | null;
  /** System limits for enforcing team/agent caps. Null falls back to defaults. */
  limits: SystemLimits | null;
  /** Skill registry for install_skill. Null disables install_skill. */
  skillRegistry: SkillRegistry | null;
  logger: {
    info(msg: string, data?: Record<string, unknown>): void;
    warn(msg: string, data?: Record<string, unknown>): void;
    error(msg: string, data?: Record<string, unknown>): void;
  };
}

// ---------------------------------------------------------------------------
// isNodeError — type guard for Node.js ErrnoException
// ---------------------------------------------------------------------------

/**
 * Returns true if err is a Node.js ErrnoException (has a string `code` field).
 * Used to distinguish ENOENT from other filesystem errors.
 */
function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return (
    err instanceof Error &&
    'code' in err &&
    typeof (err as NodeJS.ErrnoException).code === 'string'
  );
}

// ---------------------------------------------------------------------------
// registerTeamTools
// ---------------------------------------------------------------------------

/**
 * Registers all team management SDK custom tool handlers on the ToolHandler.
 */
export function registerTeamTools(handler: ToolRegistry, deps: TeamToolsDeps): void {
  handler.register('create_agent', makeCreateAgent(deps));
  handler.register('create_team', makeCreateTeam(deps));
  handler.register('delete_team', makeDeleteTeam(deps));
  handler.register('delete_agent', makeDeleteAgent(deps));
  handler.register('list_teams', makeListTeams(deps));
  handler.register('get_team', makeGetTeam(deps));
  handler.register('update_team', makeUpdateTeam(deps));
  handler.register('get_member_status', makeGetMemberStatus(deps));
  handler.register('create_skill', makeCreateSkill(deps));
  handler.register('load_skill', makeLoadSkill(deps));
  handler.register('refine_skill', makeRefineSkill(deps));
  if (deps.skillRegistry !== null) {
    handler.register('install_skill', makeInstallSkill(deps));
  }
}

// Re-export slugifyName from domain/validation for backward compatibility.
export { slugifyName } from '../domain/validation.js';

// ---------------------------------------------------------------------------
// shortID — generates an 8-character hex segment from a UUID
// ---------------------------------------------------------------------------

/**
 * Returns an 8-character lowercase alphanumeric string derived from a UUID.
 */
function shortID(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8);
}

// ---------------------------------------------------------------------------
// rebuildOrgChart — reloads all config and rebuilds the in-memory index
// ---------------------------------------------------------------------------

/**
 * Loads the current state of all configs and rebuilds the org chart.
 * Falls back to loadMaster() if getMaster() returns null/undefined.
 */
async function rebuildOrgChart(deps: TeamToolsDeps): Promise<void> {
  let master = deps.configLoader.getMaster();
  if (master == null) {
    master = await deps.configLoader.loadMaster();
  }

  const slugs = await deps.configLoader.listTeams();
  const teams: Record<string, Team> = {};

  for (const slug of slugs) {
    try {
      const team = await deps.configLoader.loadTeam(slug);
      teams[slug] = team;
    } catch (err) {
      deps.logger.warn('failed to load team during orgchart rebuild', {
        slug,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  deps.orgChart.rebuildFromConfig(master, teams);
}

// ---------------------------------------------------------------------------
// updateAgentLeadsTeam — sets the leads_team field on the leader's config entry
// ---------------------------------------------------------------------------

/**
 * Finds the leader agent in master config or team configs and sets
 * its leads_team field to the given team slug.
 */
async function updateAgentLeadsTeam(
  deps: TeamToolsDeps,
  leaderAID: string,
  teamSlug: string,
): Promise<void> {
  // Check master config first
  const master = await deps.configLoader.loadMaster();
  const masterAgents = master.agents ?? [];
  for (let i = 0; i < masterAgents.length; i++) {
    if (masterAgents[i]!.aid === leaderAID) {
      masterAgents[i] = { ...masterAgents[i]!, leads_team: teamSlug };
      master.agents = masterAgents;
      await deps.configLoader.saveMaster(master);
      return;
    }
  }

  // Check all teams
  const slugs = await deps.configLoader.listTeams();
  for (const slug of slugs) {
    let team: Team;
    try {
      team = await deps.configLoader.loadTeam(slug);
    } catch {
      continue;
    }
    const agents = team.agents ?? [];
    for (let i = 0; i < agents.length; i++) {
      if (agents[i]!.aid === leaderAID) {
        agents[i] = { ...agents[i]!, leads_team: teamSlug };
        team.agents = agents;
        await deps.configLoader.saveTeam(slug, team);
        return;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// create_agent
// ---------------------------------------------------------------------------

/**
 * Creates a new agent and adds it to the specified team (or master config).
 *
 * Args:
 *   name:         string (required) — display name
 *   description:  string (required) — agent role description
 *   team_slug:    string (required) — parent team slug, or "master"
 *   model_tier?:  string            — "haiku" | "sonnet" | "opus"
 *   provider?:    string            — provider preset name
 *
 * Returns: { aid, status: "created" }
 */
function makeCreateAgent(deps: TeamToolsDeps): ToolFunc {
  return async (args: Record<string, JsonValue>): Promise<JsonValue> => {
    const name = typeof args['name'] === 'string' ? args['name'] : '';
    let teamSlug = typeof args['team_slug'] === 'string' ? args['team_slug'] : '';
    const modelTier = typeof args['model_tier'] === 'string' ? args['model_tier'] : '';
    const provider = typeof args['provider'] === 'string' ? args['provider'] : '';

    // Accept "description" or legacy "role_file" / "role_description" as the
    // agent description.  LLMs sometimes hallucinate old parameter names from
    // training data even when the MCP schema is correct.
    let description = typeof args['description'] === 'string' ? args['description'] : '';
    if (description === '' && typeof args['role_description'] === 'string') {
      description = args['role_description'] as string;
    }
    if (description === '' && typeof args['role_file'] === 'string') {
      // role_file is a file path — derive a description from the name.
      description = `Agent: ${name}`;
      deps.logger.info('create_agent: derived description from role_file fallback', {
        name,
        role_file: args['role_file'] as string,
      });
    }

    // Accept "main" as alias for "master" — the top-level team IS "main"
    // and LLMs naturally use this term.
    if (teamSlug === 'main') {
      teamSlug = 'master';
    }

    if (name === '') {
      throw new ValidationError('name', 'name is required');
    }
    if (description === '') {
      throw new ValidationError('description', 'description is required — provide a 1-2 sentence summary of the agent role, e.g. "Fetches weather data for any location"');
    }
    if (teamSlug === '') {
      throw new ValidationError('team_slug', 'team_slug is required');
    }
    if (modelTier !== '') {
      if (!validateModelTier(modelTier)) {
        throw new ValidationError('model_tier', `invalid model_tier: ${modelTier}`);
      }
    }

    // Generate a unique AID: aid-{slug}-{8-char uuid}
    // Strip hyphens from the slug so the AID always has exactly two segments
    // after the "aid-" prefix, matching the validateAID pattern /^aid-[a-z0-9]+-[a-z0-9]+$/.
    const nameSlug = slugifyName(name).replace(/-/g, '');
    const aid = `aid-${nameSlug}-${shortID()}`;

    // Parse self_evolve (optional boolean, informational for v0)
    const selfEvolveRaw = args['self_evolve'];
    const selfEvolve = typeof selfEvolveRaw === 'boolean' ? selfEvolveRaw : undefined;

    const agent: Agent = {
      aid,
      name,
      ...(provider !== '' ? { provider } : {}),
      ...(modelTier !== '' ? { model_tier: modelTier } : {}),
      ...(selfEvolve !== undefined ? { self_evolve: selfEvolve } : {}),
    };

    if (teamSlug === 'master') {
      // Add to master config agents list
      const master = await deps.configLoader.loadMaster();
      const existingAgents = master.agents ?? [];

      // Enforce system limits (CON-03: max agents per team)
      const maxAgents = deps.limits?.max_agents_per_team ?? 10;
      if (existingAgents.length >= maxAgents) {
        throw new ValidationError(
          'team_slug',
          `maximum agents per team reached (${maxAgents})`,
        );
      }

      // Guard against duplicate AID (should not happen with UUID, but be safe)
      for (const existing of existingAgents) {
        if (existing.aid === aid) {
          throw new ConflictError('agent', 'duplicate AID');
        }
      }
      master.agents = [...existingAgents, agent];
      await deps.configLoader.saveMaster(master);
    } else {
      // Validate slug before loading team
      validateSlug(teamSlug);
      const team = await deps.configLoader.loadTeam(teamSlug);
      const existingAgents = team.agents ?? [];

      // Enforce system limits (CON-03: max agents per team)
      const maxAgents = deps.limits?.max_agents_per_team ?? 10;
      if (existingAgents.length >= maxAgents) {
        throw new ValidationError(
          'team_slug',
          `maximum agents per team reached (${maxAgents})`,
        );
      }

      for (const existing of existingAgents) {
        if (existing.aid === aid) {
          throw new ConflictError('agent', 'duplicate AID');
        }
      }
      team.agents = [...existingAgents, agent];
      await deps.configLoader.saveTeam(teamSlug, team);
    }

    // Write .claude/agents/<name>.md to workspace.
    // Best-effort: failures are logged and do not block agent creation.
    try {
      const wsSlug = teamSlug === 'master' ? 'main' : teamSlug;
      const wsDir = resolveTeamWorkspacePath(deps.runDir, wsSlug);
      const agentsDir = pathJoin(wsDir, '.claude', 'agents');
      await mkdir(agentsDir, { recursive: true });
      const frontmatterObj: Record<string, unknown> = {
        name,
        description,
        model: modelTier !== '' ? modelTier : 'sonnet',
        tools: [] as string[],
      };
      if (selfEvolve !== undefined) {
        frontmatterObj['self_evolve'] = selfEvolve;
      }
      const frontmatter = stringifyYaml(frontmatterObj);
      const body = [
        `# ${name}`,
        '',
        description,
        '',
        '## Guidelines',
        '',
        '- Focus on tasks within your area of expertise as described above',
        '- Be thorough and provide detailed results',
        '- If a task is outside your scope, say so clearly',
      ].join('\n');
      const content = `---\n${frontmatter}---\n\n${body}\n`;
      await writeFile(pathJoin(agentsDir, `${slugifyName(name)}.md`), content, { mode: 0o644 });
    } catch (err) {
      deps.logger.warn('failed to write .claude/agents/ file', {
        aid,
        error: String(err),
      });
    }

    try {
      await rebuildOrgChart(deps);
    } catch (err) {
      deps.logger.warn('failed to rebuild orgchart after create_agent', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Notify the team container about the new agent (best-effort, non-blocking).
    // Only for non-master teams — master agents run in the main container which
    // doesn't receive agent_added messages.
    if (teamSlug !== 'master' && deps.wsHub !== null) {
      try {
        deps.orgChart.getTeamBySlug(teamSlug); // Validates team exists

        // Resolve provider config from preset name (fall back to OAuth default)
        let providerCfg: ProviderConfig = { type: 'oauth' };
        if (provider !== '') {
          try {
            const providers = await deps.configLoader.loadProviders();
            const preset = providers[provider];
            if (preset !== undefined) {
              if (preset.type === 'anthropic_direct') {
                providerCfg = { type: 'anthropic_direct', api_key: preset.api_key, api_url: preset.base_url };
              } else if (preset.type === 'oauth') {
                providerCfg = { type: 'oauth', oauth_token: preset.oauth_token };
              } else {
                providerCfg = { type: preset.type, api_key: preset.api_key, api_url: preset.base_url };
              }
            }
          } catch {
            // Provider lookup failed — fall back to default OAuth
          }
        }

        const agentInit: AgentInitConfig = {
          aid,
          name,
          provider: providerCfg,
          model_tier: modelTier || 'sonnet',
          role: 'worker',
        };
        const msg = encodeMessage(MsgTypeAgentAdded, { agent: agentInit });
        await deps.wsHub.sendToTeam(teamSlug, msg);
        deps.logger.info('sent agent_added to team container', { aid, team_slug: teamSlug });
      } catch (err) {
        // Container may not be connected yet — agent file exists and will be
        // picked up on container restart.
        deps.logger.warn('failed to send agent_added to team container', {
          aid,
          team_slug: teamSlug,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    deps.logger.info('agent created', { aid, name, description, team_slug: teamSlug });

    return { aid, status: 'created' };
  };
}

// ---------------------------------------------------------------------------
// create_team
// ---------------------------------------------------------------------------

/**
 * Creates a new team with the given slug and leader AID.
 * Validates that the leader already exists in the OrgChart (two-step pattern).
 * Generates a TID, creates the team directory, saves config, and publishes
 * a team_created event.
 *
 * Args:
 *   slug:         string (required) — team slug (kebab-case)
 *   leader_aid:   string (required) — AID of the team lead agent
 *   parent_slug?: string            — parent team slug
 *
 * Returns: { tid, slug, status: "created" }
 */
function makeCreateTeam(deps: TeamToolsDeps): ToolFunc {
  return async (args: Record<string, JsonValue>, context?: ToolCallContext): Promise<JsonValue> => {
    const slug = typeof args['slug'] === 'string' ? args['slug'] : '';
    const leaderAID = typeof args['leader_aid'] === 'string' ? args['leader_aid'] : '';
    // Infer parent_slug from calling context if not explicitly provided (Finding #10).
    const explicitParent = typeof args['parent_slug'] === 'string' ? args['parent_slug'] : undefined;
    const parentSlug = explicitParent ?? context?.teamSlug;

    validateSlug(slug);
    if (isReservedSlug(slug)) {
      throw new ValidationError('slug', `slug "${slug}" is reserved`);
    }

    if (leaderAID === '') {
      throw new ValidationError('leader_aid', 'leader_aid is required');
    }
    validateAID(leaderAID);

    // Verify leader_aid exists in OrgChart
    try {
      deps.orgChart.getAgentByAID(leaderAID);
    } catch {
      throw new ValidationError(
        'leader_aid',
        `agent ${leaderAID} does not exist`,
      );
    }

    // Validate leader belongs to parent team context when explicitly specified (Finding #10).
    // Only enforce when parent_slug is explicitly provided by the caller (not inferred).
    // When inferred from context, the leader might be a top-level agent in master.agents
    // that hasn't been assigned to any team yet.
    if (explicitParent !== undefined) {
      try {
        const leaderTeam = deps.orgChart.getTeamForAgent(leaderAID);
        const parentNorm = explicitParent === 'master' ? 'main' : explicitParent;
        if (leaderTeam.slug !== parentNorm) {
          throw new ValidationError(
            'leader_aid',
            `leader must belong to parent team "${explicitParent}" (found in "${leaderTeam.slug}")`,
          );
        }
      } catch (err) {
        // NotFoundError: leader is a top-level agent in master.agents — valid.
        if (err instanceof NotFoundError) {
          // Top-level agent — no team constraint to enforce.
        } else if (err instanceof ValidationError) {
          throw err;
        }
      }
    }

    // Check for duplicate slug
    const existingSlugs = await deps.configLoader.listTeams();
    for (const existing of existingSlugs) {
      if (existing === slug) {
        throw new ConflictError('team', `team ${slug} already exists`);
      }
    }

    // Enforce system limits (CON-02: max total teams)
    const maxTeams = deps.limits?.max_teams ?? 20;
    if (existingSlugs.length >= maxTeams) {
      throw new ValidationError(
        'slug',
        `maximum team limit reached (${maxTeams})`,
      );
    }

    // Validate parent_slug exists and enforce nesting depth limit (CON-01: max_depth)
    if (parentSlug !== undefined) {
      // Only validate existence when explicitly provided by the caller.
      // When inferred from context, the team is guaranteed to exist (it's the calling team).
      if (explicitParent !== undefined) {
        try {
          deps.orgChart.getTeamBySlug(parentSlug);
        } catch {
          throw new ValidationError('parent_slug', `parent team '${parentSlug}' does not exist`);
        }
      }
      const maxDepth = deps.limits?.max_depth ?? 5;
      const depth = computeNestingDepth(deps.orgChart, parentSlug);
      if (depth + 1 > maxDepth) {
        throw new ValidationError(
          'slug',
          `maximum nesting depth reached (${maxDepth})`,
        );
      }
    }

    // Generate TID: tid-{slug[:8]}-{8-char uuid}
    const slugPrefix = slug.slice(0, 8);
    const tid = `tid-${slugPrefix}-${shortID()}`;

    const team: Team = {
      tid,
      slug,
      leader_aid: leaderAID,
      ...(parentSlug !== undefined ? { parent_slug: parentSlug } : {}),
    };

    // Create team directory and save config
    await deps.configLoader.createTeamDir(slug);
    await deps.configLoader.saveTeam(slug, team);

    // Scaffold workspace directory structure (best-effort).
    // Pass skillsSourceDir so SDK tool skills are copied into the team workspace.
    try {
      await scaffoldTeamWorkspace(deps.runDir, slug, {
        skillsSourceDir: deps.skillsSourceDir,
      });
    } catch (err) {
      deps.logger.warn('failed to scaffold workspace for new team', {
        slug,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Update leader agent's leads_team field
    try {
      await updateAgentLeadsTeam(deps, leaderAID, slug);
    } catch (err) {
      deps.logger.warn('failed to update leader agent leads_team', {
        error: err instanceof Error ? err.message : String(err),
        leader_aid: leaderAID,
      });
    }

    // Rebuild OrgChart BEFORE container provisioning (Finding #4).
    // Container init calls resolveAgentInitConfigs which reads the org chart —
    // if the org chart hasn't been rebuilt, the container gets an empty agent list.
    try {
      await rebuildOrgChart(deps);
    } catch (err) {
      deps.logger.warn('failed to rebuild orgchart after create_team', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Provision container AFTER org chart rebuild (Finding #4).
    if (deps.containerManager !== null) {
      try {
        await deps.containerManager.ensureRunning(slug);
      } catch (err) {
        deps.logger.warn('failed to provision container for new team', {
          slug,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Publish event
    if (deps.eventBus !== null) {
      deps.eventBus.publish({
        type: 'team_created',
        payload: { kind: 'team_created', team_id: tid },
      });
    }

    deps.logger.info('team created', { slug, tid, leader_aid: leaderAID });

    return { tid, slug, status: 'created' };
  };
}

// ---------------------------------------------------------------------------
// delete_team
// ---------------------------------------------------------------------------

/**
 * Deletes a team by slug. Verifies the team exists in OrgChart before
 * deleting, removes the config directory, rebuilds OrgChart, and publishes
 * a team_deleted event.
 *
 * Args:
 *   slug: string (required)
 *
 * Returns: { status: "deleted", slug }
 */
function makeDeleteTeam(deps: TeamToolsDeps): ToolFunc {
  return async (args: Record<string, JsonValue>): Promise<JsonValue> => {
    const slug = typeof args['slug'] === 'string' ? args['slug'] : '';

    validateSlug(slug);

    // Verify team exists
    let team: Team;
    try {
      team = deps.orgChart.getTeamBySlug(slug);
    } catch {
      throw new NotFoundError('team', slug);
    }

    const tid = team.tid;
    const leaderAID = team.leader_aid;

    // Step 1: Capture leader info EARLY (before cleanup invalidates orgchart).
    let leaderAgent: Agent | undefined;
    let leaderParentSlug: string | undefined;
    let leaderOtherTeams: string[] = [];
    try {
      leaderAgent = deps.orgChart.getAgentByAID(leaderAID);
      leaderOtherTeams = deps.orgChart.getLeadTeams(leaderAID).filter((s) => s !== slug);
      try {
        const parentTeam = deps.orgChart.getTeamForAgent(leaderAID);
        leaderParentSlug = parentTeam.slug;
      } catch {
        // Top-level agent in master.agents — parent is 'main'
        leaderParentSlug = 'main';
      }
    } catch {
      deps.logger.warn('leader not found in orgchart during delete_team, skipping leader cleanup', {
        slug,
        leader_aid: leaderAID,
      });
    }

    // Step 2: Existing cleanup.

    // Stop and remove container (best-effort).
    if (deps.containerManager !== null) {
      try {
        await deps.containerManager.removeTeam(slug);
      } catch (err: unknown) {
        deps.logger.warn('failed to remove container for team', {
          slug,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Cancel in-progress tasks before removing workspace.
    const tasks = await deps.taskStore.listByTeam(slug);
    for (const task of tasks) {
      if (task.status === 'pending' || task.status === 'running') {
        await deps.taskStore.update({
          ...task,
          status: 'failed',
          error: 'team deleted',
          updated_at: new Date(),
          completed_at: new Date(),
        });
      }
    }

    // Validate workspace path outside try/catch — fail-secure.
    // Throws ValidationError on path traversal or symlink attack.
    const workspacePath = validateWorkspacePath(deps.runDir, slug);

    // Remove workspace directory — tolerate ENOENT, rethrow others.
    try {
      await rm(workspacePath, { recursive: true });
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        deps.logger.warn('workspace already removed', { slug });
      } else {
        throw err;
      }
    }

    // Delete team config directory
    await deps.configLoader.deleteTeamDir(slug);

    // Rebuild OrgChart
    try {
      await rebuildOrgChart(deps);
    } catch (err) {
      deps.logger.warn('failed to rebuild orgchart after delete_team', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Step 3: Best-effort leader cleanup AFTER all core cleanup succeeds.
    if (leaderAgent !== undefined) {
      // Never delete the main assistant.
      if (leaderAID === 'aid-main-001') {
        deps.logger.info('skipping leader cleanup for main assistant', { leader_aid: leaderAID });
      } else if (leaderOtherTeams.length > 0) {
        deps.logger.info('leader leads other teams, skipping deletion', {
          leader_aid: leaderAID,
          other_teams: leaderOtherTeams,
        });
      } else {
        try {
          // Remove leader from parent config.
          if (leaderParentSlug === 'main') {
            const master = await deps.configLoader.loadMaster();
            master.agents = (master.agents ?? []).filter((a) => a.aid !== leaderAID);
            await deps.configLoader.saveMaster(master);
          } else if (leaderParentSlug !== undefined) {
            const parentTeam = await deps.configLoader.loadTeam(leaderParentSlug);
            parentTeam.agents = (parentTeam.agents ?? []).filter((a) => a.aid !== leaderAID);
            await deps.configLoader.saveTeam(leaderParentSlug, parentTeam);
          }

          // Delete leader's .md from parent workspace.
          try {
            const wsSlug = leaderParentSlug === 'main' ? 'main' : (leaderParentSlug ?? 'main');
            const agentFileName = `${slugifyName(leaderAgent.name)}.md`;
            const wsDir = resolveTeamWorkspacePath(deps.runDir, wsSlug);
            const filePath = pathJoin(wsDir, '.claude', 'agents', agentFileName);
            await unlink(filePath);
          } catch (err) {
            if (isNodeError(err) && err.code === 'ENOENT') {
              deps.logger.warn('leader .md already removed', { leader_aid: leaderAID });
            } else {
              deps.logger.warn('failed to delete leader .md file', { leader_aid: leaderAID, error: String(err) });
            }
          }

          // Rebuild orgchart again (config changed).
          try {
            await rebuildOrgChart(deps);
          } catch (err) {
            deps.logger.warn('failed to rebuild orgchart after leader cleanup', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        } catch (err) {
          deps.logger.warn('failed to clean up leader agent during delete_team', {
            leader_aid: leaderAID,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Publish event
    if (deps.eventBus !== null) {
      deps.eventBus.publish({
        type: 'team_deleted',
        payload: { kind: 'team_deleted', team_id: tid },
      });
    }

    deps.logger.info('team deleted', { slug });

    return { status: 'deleted', slug };
  };
}

// ---------------------------------------------------------------------------
// delete_agent
// ---------------------------------------------------------------------------

/**
 * Deletes an agent from the specified team (or master config).
 * Prevents deletion if the agent leads a team — those must be deleted first.
 *
 * Args:
 *   aid:       string (required) — agent AID
 *   team_slug: string (required) — parent team slug, or "master"
 *
 * Returns: { status: "deleted", aid }
 */
function makeDeleteAgent(deps: TeamToolsDeps): ToolFunc {
  return async (args: Record<string, JsonValue>): Promise<JsonValue> => {
    const aid = typeof args['aid'] === 'string' ? args['aid'] : '';
    let teamSlug = typeof args['team_slug'] === 'string' ? args['team_slug'] : '';

    // Accept "main" as alias for "master"
    if (teamSlug === 'main') {
      teamSlug = 'master';
    }

    validateAID(aid);

    if (teamSlug === '') {
      throw new ValidationError('team_slug', 'team_slug is required');
    }

    // Check if agent leads a team (cascade warning)
    const leadTeams = deps.orgChart.getLeadTeams(aid);
    if (leadTeams.length > 0) {
      throw new ValidationError(
        'aid',
        `agent ${aid} leads team(s) ${JSON.stringify(leadTeams)} — delete the team(s) first`,
      );
    }

    let removedAgent: Agent | undefined;

    if (teamSlug === 'master') {
      const master = await deps.configLoader.loadMaster();
      const existing = master.agents ?? [];
      const newAgents: Agent[] = [];
      let found = false;
      for (const agent of existing) {
        if (agent.aid === aid) {
          found = true;
          removedAgent = agent;
        } else {
          newAgents.push(agent);
        }
      }
      if (!found) {
        throw new NotFoundError('agent', aid);
      }
      master.agents = newAgents;
      await deps.configLoader.saveMaster(master);
    } else {
      validateSlug(teamSlug);
      const team = await deps.configLoader.loadTeam(teamSlug);
      const existing = team.agents ?? [];
      const newAgents: Agent[] = [];
      let found = false;
      for (const agent of existing) {
        if (agent.aid === aid) {
          found = true;
          removedAgent = agent;
        } else {
          newAgents.push(agent);
        }
      }
      if (!found) {
        throw new NotFoundError('agent', aid);
      }
      team.agents = newAgents;
      await deps.configLoader.saveTeam(teamSlug, team);
    }

    // Delete agent's .md file from workspace (best-effort).
    if (removedAgent !== undefined) {
      try {
        const wsSlug = teamSlug === 'master' ? 'main' : teamSlug;
        const agentFileName = `${slugifyName(removedAgent.name)}.md`;
        const wsDir = resolveTeamWorkspacePath(deps.runDir, wsSlug);
        const filePath = pathJoin(wsDir, '.claude', 'agents', agentFileName);
        await unlink(filePath);
      } catch (err) {
        if (isNodeError(err) && err.code === 'ENOENT') {
          deps.logger.warn('agent .md already removed', { aid });
        } else {
          deps.logger.warn('failed to delete agent .md file', { aid, error: String(err) });
        }
      }
    }

    // Rebuild OrgChart
    try {
      await rebuildOrgChart(deps);
    } catch (err) {
      deps.logger.warn('failed to rebuild orgchart after delete_agent', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    deps.logger.info('agent deleted', { aid, team_slug: teamSlug });

    return { status: 'deleted', aid };
  };
}

// ---------------------------------------------------------------------------
// list_teams
// ---------------------------------------------------------------------------

/**
 * Returns all teams from the OrgChart as a map of slug → Team.
 */
function makeListTeams(deps: TeamToolsDeps): ToolFunc {
  return async (_args: Record<string, JsonValue>): Promise<JsonValue> => {
    const teams = deps.orgChart.getOrgChart();
    return teams as unknown as JsonValue;
  };
}

// ---------------------------------------------------------------------------
// get_team
// ---------------------------------------------------------------------------

/**
 * Returns the team configuration for the given slug.
 *
 * Args:
 *   slug: string (required)
 */
function makeGetTeam(deps: TeamToolsDeps): ToolFunc {
  return async (args: Record<string, JsonValue>): Promise<JsonValue> => {
    const slug = typeof args['slug'] === 'string' ? args['slug'] : '';

    validateSlug(slug);

    const team = await deps.configLoader.loadTeam(slug);
    return team as unknown as JsonValue;
  };
}

// ---------------------------------------------------------------------------
// update_team
// ---------------------------------------------------------------------------

/** Whitelist of fields that can be updated via update_team. */
const ALLOWED_TEAM_FIELDS: ReadonlySet<string> = new Set(['env_vars', 'container_config']);

/**
 * Updates a team field (env_vars or container_config) and saves.
 *
 * Args:
 *   slug:  string (required)
 *   field: string (required) — "env_vars" | "container_config"
 *   value: JsonValue (required) — new value
 *
 * Returns: { status: "updated", slug, field }
 */
function makeUpdateTeam(deps: TeamToolsDeps): ToolFunc {
  return async (args: Record<string, JsonValue>): Promise<JsonValue> => {
    const slug = typeof args['slug'] === 'string' ? args['slug'] : '';
    const field = typeof args['field'] === 'string' ? args['field'] : '';
    const value = args['value'];

    validateSlug(slug);

    if (field === '') {
      throw new ValidationError('field', 'field is required');
    }
    if (!ALLOWED_TEAM_FIELDS.has(field)) {
      throw new ValidationError(
        'field',
        `field "${field}" is not updatable; allowed: env_vars, container_config`,
      );
    }
    if (value === undefined || value === null) {
      throw new ValidationError('value', 'value is required');
    }

    // The MCP bridge may serialize objects as JSON strings. Parse if needed.
    let parsedValue: string | number | boolean | JsonValue[] | { [key: string]: JsonValue } = value;
    if (typeof parsedValue === 'string') {
      try {
        const parsed: unknown = JSON.parse(parsedValue);
        if (typeof parsed === 'object' && parsed !== null) {
          parsedValue = parsed as JsonValue[] | { [key: string]: JsonValue };
        }
      } catch {
        // Not valid JSON — fall through to field-specific validation
      }
    }

    const team = await deps.configLoader.loadTeam(slug);

    switch (field) {
      case 'env_vars': {
        // value must be Record<string, string>
        if (
          typeof parsedValue !== 'object' ||
          Array.isArray(parsedValue) ||
          parsedValue === null
        ) {
          throw new ValidationError('value', 'env_vars must be a string map');
        }
        const envRecord = parsedValue as Record<string, JsonValue>;
        const envVars: Record<string, string> = {};
        for (const [k, v] of Object.entries(envRecord)) {
          if (typeof v !== 'string') {
            throw new ValidationError('value', 'env_vars must be a string map');
          }
          envVars[k] = v;
        }
        team.env_vars = envVars;
        break;
      }

      case 'container_config': {
        // value must be a ContainerConfig-shaped object
        if (
          typeof parsedValue !== 'object' ||
          Array.isArray(parsedValue) ||
          parsedValue === null
        ) {
          throw new ValidationError('value', 'container_config must be a ContainerConfig object');
        }
        const cc = parsedValue as Record<string, JsonValue>;
        const containerConfig: ContainerConfig = {};
        if (cc['max_memory'] !== undefined) {
          if (typeof cc['max_memory'] !== 'string') {
            throw new ValidationError('value', 'container_config.max_memory must be a string');
          }
          containerConfig.max_memory = cc['max_memory'];
        }
        if (cc['max_old_space'] !== undefined) {
          if (typeof cc['max_old_space'] !== 'number') {
            throw new ValidationError('value', 'container_config.max_old_space must be a number');
          }
          containerConfig.max_old_space = cc['max_old_space'];
        }
        if (cc['idle_timeout'] !== undefined) {
          if (typeof cc['idle_timeout'] !== 'string') {
            throw new ValidationError('value', 'container_config.idle_timeout must be a string');
          }
          containerConfig.idle_timeout = cc['idle_timeout'];
        }
        team.container_config = containerConfig;
        break;
      }
    }

    await deps.configLoader.saveTeam(slug, team);

    deps.logger.info('team updated', { slug, field });

    return { status: 'updated', slug, field };
  };
}

// ---------------------------------------------------------------------------
// get_member_status
// ---------------------------------------------------------------------------

/**
 * Returns the current status of an agent or team from the OrgChart.
 * Either agent_aid or team_slug is required (agent_aid takes precedence).
 *
 * Args:
 *   agent_aid?: string — AID of the agent to look up
 *   team_slug?: string — team slug to look up
 */
function makeGetMemberStatus(deps: TeamToolsDeps): ToolFunc {
  return async (args: Record<string, JsonValue>): Promise<JsonValue> => {
    const agentAID = typeof args['agent_aid'] === 'string' ? args['agent_aid'] : '';
    const teamSlug = typeof args['team_slug'] === 'string' ? args['team_slug'] : '';

    if (agentAID === '' && teamSlug === '') {
      throw new ValidationError('args', 'either agent_aid or team_slug is required');
    }

    if (agentAID !== '') {
      validateAID(agentAID);
      const agent = deps.orgChart.getAgentByAID(agentAID);
      return agent as unknown as JsonValue;
    }

    // team_slug query
    validateSlug(teamSlug);
    const team = deps.orgChart.getTeamBySlug(teamSlug);
    return team as unknown as JsonValue;
  };
}

// ---------------------------------------------------------------------------
// writeSkillFile
// ---------------------------------------------------------------------------

/**
 * Parameters for writeSkillFile.
 */
export interface WriteSkillFileParams {
  name: string;
  description?: string;
  argumentHint?: string;
  allowedTools?: string[];
  body: string;
}

/**
 * Writes a skill definition to the workspace in .claude/skills/<name>/SKILL.md format.
 *
 * Creates the directory:
 *   <workspaceDir>/.claude/skills/<name>/
 *
 * Writes the file:
 *   <workspaceDir>/.claude/skills/<name>/SKILL.md
 *
 * The file contains a YAML frontmatter block followed by the skill body.
 * Frontmatter keys use Claude Code SDK naming conventions:
 *   - name
 *   - description (if provided)
 *   - argument-hint (if provided)
 *   - allowed-tools (if provided and non-empty)
 *
 * Throws ValidationError if skill.name is invalid.
 * Throws if the directory cannot be created or the file cannot be written.
 */
export async function writeSkillFile(workspaceDir: string, skill: WriteSkillFileParams): Promise<void> {
  // Validate name using the same rules as SkillLoader
  validateSkillName(skill.name);

  const skillDir = pathJoin(workspaceDir, '.claude', 'skills', skill.name);
  await mkdir(skillDir, { recursive: true });

  // Build frontmatter object — only include fields that have values.
  // Use Claude Code SDK key names (argument-hint, allowed-tools).
  const frontmatterObj: Record<string, JsonValue> = { name: skill.name };
  if (skill.description !== undefined && skill.description !== '') {
    frontmatterObj['description'] = skill.description;
  }
  if (skill.argumentHint !== undefined && skill.argumentHint !== '') {
    frontmatterObj['argument-hint'] = skill.argumentHint;
  }
  if (skill.allowedTools !== undefined && skill.allowedTools.length > 0) {
    frontmatterObj['allowed-tools'] = skill.allowedTools;
  }

  const frontmatter = stringifyYaml(frontmatterObj, { lineWidth: 0 });
  const content = `---\n${frontmatter}---\n\n${skill.body}`;

  await writeFile(pathJoin(skillDir, 'SKILL.md'), content, { mode: 0o644 });
}

// ---------------------------------------------------------------------------
// create_skill
// ---------------------------------------------------------------------------

/**
 * Creates a skill definition file in the workspace's .claude/skills/<name>/SKILL.md.
 *
 * Args:
 *   name:          string   (required) — skill name (valid skill name characters)
 *   team_slug:     string   (required) — team slug, or "master" for root workspace
 *   body:          string   (required) — skill body / system prompt addition
 *   description?:  string             — human-readable description
 *   argument_hint?: string            — hint text for the argument-hint frontmatter field
 *   allowed_tools?: string[]          — list of allowed tool names
 *
 * Returns: { name, status: "created" }
 */
function makeCreateSkill(deps: TeamToolsDeps): ToolFunc {
  return async (args: Record<string, JsonValue>): Promise<JsonValue> => {
    const name = typeof args['name'] === 'string' ? args['name'] : '';
    const teamSlug = typeof args['team_slug'] === 'string' ? args['team_slug'] : '';
    const body = typeof args['body'] === 'string' ? args['body'] : '';
    const description = typeof args['description'] === 'string' ? args['description'] : undefined;
    const argumentHint =
      typeof args['argument_hint'] === 'string' ? args['argument_hint'] : undefined;

    // Extract allowed_tools: must be an array of strings if present.
    let allowedTools: string[] | undefined;
    if (Array.isArray(args['allowed_tools'])) {
      const toolsArr = args['allowed_tools'] as JsonValue[];
      allowedTools = toolsArr.filter((t): t is string => typeof t === 'string');
    }

    if (name === '') {
      throw new ValidationError('name', 'name is required');
    }
    if (teamSlug === '') {
      throw new ValidationError('team_slug', 'team_slug is required');
    }
    if (body === '') {
      throw new ValidationError('body', 'body is required');
    }

    // validateSkillName will throw ValidationError for path traversal / invalid chars
    validateSkillName(name);

    // Validate team_slug before any filesystem operation.
    // "master" is a special sentinel that maps to "main" — validate the
    // non-sentinel value only.  The 'master' → 'main' mapping happens AFTER.
    if (teamSlug !== 'master') {
      validateSlug(teamSlug);
    }

    // Resolve workspace directory: "master" maps to "main"
    const wsSlug = teamSlug === 'master' ? 'main' : teamSlug;

    let workspaceDir: string;
    if (wsSlug === 'main') {
      // Main workspace is the root workspace, not under workspace/teams/.
      workspaceDir = resolveTeamWorkspacePath(deps.runDir, 'main');
    } else {
      // validateWorkspacePath enforces path containment and rejects symlinks.
      workspaceDir = validateWorkspacePath(deps.runDir, wsSlug);
    }

    await writeSkillFile(workspaceDir, { name, description, argumentHint, allowedTools, body });

    deps.logger.info('skill created', { name, team_slug: teamSlug });

    return { name, status: 'created' };
  };
}

// ---------------------------------------------------------------------------
// load_skill
// ---------------------------------------------------------------------------

/**
 * Creates the handler for the `load_skill` SDK tool.
 * Reads a skill SKILL.md file and returns its content.
 */
function makeLoadSkill(deps: TeamToolsDeps): ToolFunc {
  return async (args: Record<string, JsonValue>): Promise<JsonValue> => {
    const skillName = typeof args['skill_name'] === 'string' ? args['skill_name'] : '';
    const teamSlug = typeof args['team_slug'] === 'string' ? args['team_slug'] : '';

    if (skillName === '') {
      throw new ValidationError('skill_name', 'skill_name is required');
    }
    if (teamSlug === '') {
      throw new ValidationError('team_slug', 'team_slug is required');
    }

    // Resolve workspace directory: "master" maps to "main"
    const wsSlug = teamSlug === 'master' ? 'main' : teamSlug;

    let workspaceDir: string;
    if (wsSlug === 'main') {
      workspaceDir = resolveTeamWorkspacePath(deps.runDir, 'main');
    } else {
      workspaceDir = validateWorkspacePath(deps.runDir, wsSlug);
    }

    const loader = new SkillLoader(workspaceDir, deps.logger);
    const skill = loader.loadSkill(skillName);

    return {
      name: skill.name,
      description: skill.description ?? '',
      body: skill.system_prompt_addition ?? '',
    };
  };
}

// ---------------------------------------------------------------------------
// refine_skill
// ---------------------------------------------------------------------------

/**
 * Reads an existing skill, allows update, writes back.
 * Hot-reload (500ms debounce) picks up changes automatically.
 *
 * Args:
 *   name:          string (required) — skill name
 *   team_slug:     string (required) — team slug, or "master" for root
 *   body:          string (required) — updated skill body
 *   description?:  string           — updated description
 *
 * Returns: { name, status: "refined" }
 */
function makeRefineSkill(deps: TeamToolsDeps): ToolFunc {
  return async (args: Record<string, JsonValue>): Promise<JsonValue> => {
    const name = typeof args['name'] === 'string' ? args['name'] : '';
    const teamSlug = typeof args['team_slug'] === 'string' ? args['team_slug'] : '';
    const body = typeof args['body'] === 'string' ? args['body'] : '';
    const description = typeof args['description'] === 'string' ? args['description'] : undefined;

    if (name === '') {
      throw new ValidationError('name', 'name is required');
    }
    if (teamSlug === '') {
      throw new ValidationError('team_slug', 'team_slug is required');
    }
    if (body === '') {
      throw new ValidationError('body', 'body is required');
    }

    validateSkillName(name);

    if (teamSlug !== 'master') {
      validateSlug(teamSlug);
    }

    const wsSlug = teamSlug === 'master' ? 'main' : teamSlug;

    let workspaceDir: string;
    if (wsSlug === 'main') {
      workspaceDir = resolveTeamWorkspacePath(deps.runDir, 'main');
    } else {
      workspaceDir = validateWorkspacePath(deps.runDir, wsSlug);
    }

    // Verify the skill exists and read existing metadata
    const skillFilePath = pathJoin(workspaceDir, '.claude', 'skills', name, 'SKILL.md');
    let existingContent: string;
    try {
      existingContent = await readFile(skillFilePath, 'utf-8');
    } catch {
      throw new NotFoundError('skill', name);
    }

    // Parse existing frontmatter to preserve metadata not provided in this call
    let existingArgumentHint: string | undefined;
    let existingAllowedTools: string[] | undefined;
    let existingDescription: string | undefined;
    const fmMatch = existingContent.match(/^---\s*\n([\s\S]*?)\n---/);
    if (fmMatch !== null) {
      const fm = fmMatch[1]!;
      const descMatch = fm.match(/^description:\s*["']?([^\n"']+)["']?\s*$/m);
      if (descMatch !== null) existingDescription = descMatch[1]!.trim();
      const hintMatch = fm.match(/^argument-hint:\s*["']?([^\n"']+)["']?\s*$/m);
      if (hintMatch !== null) existingArgumentHint = hintMatch[1]!.trim();
      const toolsMatch = fm.match(/^allowed-tools:\s*\n((?:\s*-\s*.+\n?)*)/m);
      if (toolsMatch !== null) {
        existingAllowedTools = toolsMatch[1]!
          .split('\n')
          .map((line) => line.replace(/^\s*-\s*/, '').trim())
          .filter((t) => t !== '');
      }
    }

    // Merge: caller-provided values override existing; existing preserved otherwise
    await writeSkillFile(workspaceDir, {
      name,
      description: description ?? existingDescription,
      argumentHint: existingArgumentHint,
      allowedTools: existingAllowedTools,
      body,
    });

    deps.logger.info('skill refined', { name, team_slug: teamSlug });

    return { name, status: 'refined' };
  };
}

// ---------------------------------------------------------------------------
// install_skill
// ---------------------------------------------------------------------------

/**
 * Installs a skill from an external registry or direct URL into a team workspace.
 *
 * Args:
 *   team_slug: string (required) — target team
 *   name?:     string           — skill name (for registry lookup)
 *   url?:      string           — direct URL to SKILL.md
 *   registry_url?: string       — registry URL override
 *
 * Returns: { name, status: "installed" }
 */
function makeInstallSkill(deps: TeamToolsDeps): ToolFunc {
  return async (args: Record<string, JsonValue>): Promise<JsonValue> => {
    const teamSlug = typeof args['team_slug'] === 'string' ? args['team_slug'] : '';
    const name = typeof args['name'] === 'string' ? args['name'] : undefined;
    const url = typeof args['url'] === 'string' ? args['url'] : undefined;
    const registryUrl = typeof args['registry_url'] === 'string' ? args['registry_url'] : undefined;

    if (teamSlug === '') {
      throw new ValidationError('team_slug', 'team_slug is required');
    }
    if ((name === undefined || name === '') && (url === undefined || url === '')) {
      throw new ValidationError('name', 'either name or url must be provided');
    }

    if (deps.skillRegistry === null) {
      throw new ValidationError('skill_registry', 'skill registry is not configured');
    }

    if (teamSlug !== 'master') {
      validateSlug(teamSlug);
    }

    const wsSlug = teamSlug === 'master' ? 'main' : teamSlug;

    let workspaceDir: string;
    if (wsSlug === 'main') {
      workspaceDir = resolveTeamWorkspacePath(deps.runDir, 'main');
    } else {
      workspaceDir = validateWorkspacePath(deps.runDir, wsSlug);
    }

    const installedName = await deps.skillRegistry.install(
      { name, registryUrl, url },
      workspaceDir,
    );

    deps.logger.info('skill installed', {
      name: installedName,
      team_slug: teamSlug,
      url: url ?? `registry/${name ?? ''}`,
    });

    return { name: installedName, status: 'installed' };
  };
}

// ---------------------------------------------------------------------------
// computeNestingDepth — count depth of team hierarchy from a parent slug
// ---------------------------------------------------------------------------

/**
 * Computes the nesting depth of a team by walking parent_slug links
 * upward through the OrgChart. Returns the number of ancestors.
 *
 * Root-level teams (parent_slug undefined) have depth 1.
 * A child of root has depth 2, and so on.
 *
 * Guards against cycles with a maximum iteration count.
 */
function computeNestingDepth(orgChart: OrgChart, parentSlug: string): number {
  let depth = 0;
  let currentSlug = parentSlug;
  const maxIterations = 20; // safety guard against cycles

  for (let i = 0; i < maxIterations; i++) {
    try {
      const team = orgChart.getTeamBySlug(currentSlug);
      depth++;
      if (team.parent_slug === undefined || team.parent_slug === '') {
        break;
      }
      currentSlug = team.parent_slug;
    } catch {
      // Team not found — we've reached the root
      break;
    }
  }

  return depth;
}
