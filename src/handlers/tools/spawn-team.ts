/**
 * spawn_team tool — creates a new team in the org tree and spawns its session.
 *
 * Input: {name, config_path?, description?, scope_accepts?,
 *         init_context?, credentials?}
 *
 * Config is loaded via deps.loadConfig which either reads an existing
 * config.yaml or generates a default. The tool then scaffolds directories,
 * writes the config to .run/teams/{name}/config.yaml, optionally writes
 * credentials and init context to memory/, registers in the org tree,
 * spawns the session, and auto-queues an initialization task.
 *
 * On any failure, all artifacts (dirs, org tree, session) are cleaned up.
 */

import { z } from 'zod';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stringify as yamlStringify } from 'yaml';
import type { OrgTree } from '../../domain/org-tree.js';
import type { ISessionSpawner, ITaskQueueStore, ITriggerConfigStore } from '../../domain/interfaces.js';
import { TeamStatus } from '../../domain/types.js';
import type { TeamConfig } from '../../domain/types.js';
import { scrubSecrets } from '../../logging/credential-scrubber.js';
import { errorMessage } from '../../domain/errors.js';
import { extractStringCredentials } from '../../domain/credential-utils.js';
import { cleanupTeamDirs } from './team-fs.js';

// Re-exported so callers that previously imported from spawn-team keep working.
export {
  jitteredCron,
  reflectionJitteredCron,
  seedLearningTrigger,
  seedReflectionTrigger,
} from './trigger-seed.js';

/** Team names must be lowercase slugs to prevent path traversal. */
const TEAM_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const SpawnTeamInputSchema = z.object({
  name: z.string().min(1).regex(TEAM_SLUG_RE, 'team name must be a lowercase slug (a-z0-9 and hyphens)'),
  config_path: z.string().optional(),
  description: z.string().optional(),
  scope_accepts: z.array(z.string().trim().min(1)).optional(),
  init_context: z.string().optional(),
  credentials: z.record(z.string(), z.string()).optional(),
}).refine(
  (data) => data.config_path || (data.scope_accepts && data.scope_accepts.length > 0),
  { message: 'scope_accepts with at least one keyword is required when config_path is not provided', path: ['scope_accepts'] },
);

export type SpawnTeamInput = z.infer<typeof SpawnTeamInputSchema>;

export interface SpawnTeamResult {
  readonly success: boolean;
  readonly team?: string;
  readonly error?: string;
  readonly note?: string;
  // NEW: truthful queued status fields (success path only)
  readonly status?: 'queued' | 'failed';
  readonly bootstrap_task_id?: string;
  readonly message_for_user?: string;
}

export interface SpawnTeamConfigHints {
  readonly description?: string;
  readonly scopeAccepts?: string[];
  readonly parent?: string;
}

export interface SpawnTeamDeps {
  readonly orgTree: OrgTree;
  readonly spawner: ISessionSpawner;
  readonly runDir: string;
  readonly loadConfig: (name: string, configPath?: string, hints?: SpawnTeamConfigHints) => TeamConfig;
  readonly taskQueue?: ITaskQueueStore;
  readonly vaultStore?: {
    set(teamName: string, key: string, value: string, isSecret: boolean, updatedBy?: string): unknown;
    removeByTeam(teamName: string): void;
  };
  readonly triggerConfigStore?: ITriggerConfigStore;
}

/** Subdirectories to scaffold for each new team. */
const TEAM_SUBDIRS = [
  'org-rules', 'team-rules', 'skills', 'subagents', 'plugins',
] as const;

/** Scaffold the team directory structure under .run/teams/{name}/. */
function scaffoldTeamDirs(runDir: string, teamName: string): void {
  const teamDir = join(runDir, 'teams', teamName);
  for (const sub of TEAM_SUBDIRS) {
    mkdirSync(join(teamDir, sub), { recursive: true });
  }

}

export async function spawnTeam(
  input: SpawnTeamInput,
  callerId: string,
  deps: SpawnTeamDeps,
  sourceChannelId?: string,
): Promise<SpawnTeamResult> {
  const parsed = SpawnTeamInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: `invalid input: ${parsed.error.message}` };
  }

  const { name, config_path } = parsed.data;

  // Check if team already exists
  if (deps.orgTree.getTeam(name)) {
    return { success: false, error: `team "${name}" already exists` };
  }

  // Verify the resolved path stays within .run/teams/ (defense in depth)
  const teamsBase = resolve(deps.runDir, 'teams');
  const teamDir = resolve(teamsBase, name);
  if (!teamDir.startsWith(teamsBase + '/')) {
    return { success: false, error: 'path traversal detected in team name' };
  }

  // Load config — loadConfig either reads from config_path or generates one.
  let config: TeamConfig;
  try {
    const hints: SpawnTeamConfigHints = {
      description: parsed.data.description,
      scopeAccepts: parsed.data.scope_accepts,
      parent: callerId,
    };
    config = deps.loadConfig(name, config_path, hints);
    // Ensure parent matches the actual caller, regardless of config source
    config = { ...config, parent: callerId };
  } catch (err) {
    const msg = errorMessage(err);
    return { success: false, error: `config error: ${msg}` };
  }

  // Store credentials + scaffold dirs/files (extracted to keep spawnTeam under complexity limit)
  const artifactErr = setupTeamArtifacts(name, config, parsed.data, deps, callerId);
  if (artifactErr) return { success: false, error: artifactErr };

  // Register in org tree
  deps.orgTree.addTeam({
    teamId: name,
    name,
    parentId: callerId,
    status: TeamStatus.Active,
    agents: [],
    children: [],
  });

  // Write scope keywords to SQLite
  if (parsed.data.scope_accepts && parsed.data.scope_accepts.length > 0) {
    deps.orgTree.addScopeKeywords(name, parsed.data.scope_accepts);
  }

  // Spawn the session
  try {
    await deps.spawner.spawn(name, name);
  } catch (err) {
    deps.orgTree.removeTeam(name);
    deps.vaultStore?.removeByTeam(name);
    cleanupTeamDirs(deps.runDir, name);
    const msg = errorMessage(err);
    return { success: false, error: `spawn failed: ${msg}` };
  }

  // Auto-queue initialization task so the team self-bootstraps
  const initResult = enqueueInitTask(name, parsed.data.init_context, deps, sourceChannelId);
  if (initResult !== null && !initResult.ok) {
    return { success: false, error: initResult.error };
  }
  const bootstrapTaskId = initResult?.taskId;

  // Success: team is queued for bootstrap; surface task ID and user-facing message
  const note = parsed.data.credentials ? 'Credentials stored securely. Do NOT echo credential values.' : undefined;
  return {
    success: true,
    status: 'queued',
    team: name,
    bootstrap_task_id: bootstrapTaskId,
    message_for_user: `Team ${name} is being set up. I'll confirm here when it's ready.`,
    ...(note ? { note } : {}),
  };
}

/**
 * Store credentials in vault and scaffold team dirs + config file + init context.
 * Returns an error string on failure, or null on success.
 * Rolls back vault entries on scaffold failure.
 */
function setupTeamArtifacts(
  name: string,
  config: TeamConfig,
  data: SpawnTeamInput,
  deps: SpawnTeamDeps,
  callerId: string,
): string | null {
  // AC-10: vault is sole runtime credential source
  const hasCredentials = data.credentials && Object.keys(data.credentials).length > 0;
  if (hasCredentials && deps.vaultStore) {
    for (const [key, value] of Object.entries(data.credentials!)) {
      deps.vaultStore.set(name, key, value, true, callerId);
    }
  } else if (hasCredentials) {
    return 'credentials require vaultStore — vault is the sole runtime credential source';
  }

  try {
    scaffoldTeamDirs(deps.runDir, name);
    writeFileSync(join(deps.runDir, 'teams', name, 'config.yaml'), yamlStringify(config), 'utf-8');
    if (data.init_context) {
      const initPath = join(deps.runDir, 'teams', name, 'team-rules', 'team-context.md');
      let safeContext = data.init_context;
      if (data.credentials) {
        const credValues = extractStringCredentials(data.credentials);
        if (credValues.length > 0) safeContext = scrubSecrets(safeContext, [], credValues);
      }
      writeFileSync(initPath, safeContext, 'utf-8');
    }
    return null;
  } catch (err) {
    deps.vaultStore?.removeByTeam(name);
    cleanupTeamDirs(deps.runDir, name);
    return `scaffold error: ${errorMessage(err)}`;
  }
}

/** Build and enqueue the bootstrap initialization task.
 * Returns { ok: true, taskId } on success, { ok: false, error } on failure,
 * or null when no taskQueue is configured.
 */
function enqueueInitTask(
  name: string,
  initContext: string | undefined,
  deps: SpawnTeamDeps,
  sourceChannelId?: string,
): { ok: true; taskId: string } | { ok: false; error: string } | null {
  if (!deps.taskQueue) return null;

  const sharedSteps =
    'Follow the v0.5.0 five-layer hierarchy (Main Agent → Team Orchestrator → Subagent → Skill → Plugin): ' +
    '(1) Author one or more subagents under subagents/ — each subagent markdown declares its role, boundaries, and communication style. ' +
    '(2) Create and register plugins under plugins/ for deterministic tool capabilities (use register_plugin_tool for runtime registration). ' +
    '(3) Create skills under skills/ that subagents can invoke to do repeatable work. ' +
    '(4) Use memory_save to record your team identity, key decisions, and initial context. ' +
    '(5) Respond with a brief, user-friendly summary of your new capabilities.';
  const initPayload = initContext
    ? 'Bootstrap this team. Your team context is already in your system prompt (from team-rules/team-context.md). ' +
      'Use the vault_get tool to access any credentials provided during team creation. ' +
      sharedSteps
    : 'Bootstrap this team. Your description and scope are in your system prompt. ' +
      sharedSteps;

  try {
    const taskId = deps.taskQueue.enqueue(name, initPayload, 'critical', 'bootstrap', sourceChannelId);
    return { ok: true, taskId };
  } catch (err) {
    // Roll back everything: session + org tree + vault + dirs
    try { deps.spawner.stop?.(name); } catch { /* best effort */ }
    deps.orgTree.removeTeam(name);
    deps.vaultStore?.removeByTeam(name);
    cleanupTeamDirs(deps.runDir, name);
    const msg = errorMessage(err);
    return { ok: false, error: `init enqueue failed: ${msg}` };
  }
}

