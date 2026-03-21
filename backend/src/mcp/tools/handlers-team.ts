/**
 * Team tool handlers: create_team, create_agent.
 *
 * @module mcp/tools/handlers-team
 */

import { AgentStatus } from '../../domain/index.js';
import { ValidationError, NotFoundError } from '../../domain/errors.js';
import { validateSlug } from '../../domain/domain.js';
import { CreateTeamSchema, CreateAgentSchema } from './schemas.js';
import { generateId } from './helpers.js';
import type { ToolContext, ToolHandler } from './types.js';

export function createTeamHandlers(ctx: ToolContext): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  handlers.set('create_team', async (args, agentAid) => {
    const parsed = CreateTeamSchema.parse(args);
    validateSlug(parsed.slug);

    const callerAgent = ctx.orgChart.getAgent(agentAid);
    const parentTeam = callerAgent ? ctx.orgChart.getTeamBySlug(callerAgent.teamSlug) : undefined;
    const parentTid = parentTeam?.tid ?? '';
    const parentDepth = parentTeam?.depth ?? 0;

    // CON-01: Enforce max nesting depth
    if (parentDepth + 1 > ctx.limits.max_depth) {
      ctx.logger.audit('security.limit_breach', {
        type: 'max_depth',
        attempted: parentDepth + 1,
        limit: ctx.limits.max_depth,
        agent_aid: agentAid,
      });
      throw new ValidationError(
        `Team nesting depth ${parentDepth + 1} exceeds maximum of ${ctx.limits.max_depth}`
      );
    }

    // CON-02: Enforce max child teams per parent
    const siblings = ctx.orgChart.getChildren(parentTid);
    if (siblings.length >= ctx.limits.max_teams) {
      ctx.logger.audit('security.limit_breach', {
        type: 'max_teams',
        current: siblings.length,
        limit: ctx.limits.max_teams,
        agent_aid: agentAid,
      });
      throw new ValidationError(
        `Parent team already has ${siblings.length} child teams (max: ${ctx.limits.max_teams})`
      );
    }

    // Scaffold workspace
    const parentPath = parentTeam?.workspacePath ?? '/app/workspace';
    if (ctx.workspaceLock) {
      await ctx.workspaceLock.acquire(parentPath);
    }
    let workspacePath: string;
    try {
      workspacePath = await ctx.provisioner.scaffoldWorkspace(parentPath, parsed.slug);
    } finally {
      if (ctx.workspaceLock) {
        ctx.workspaceLock.release(parentPath);
      }
    }

    // Spawn container first - it generates the authoritative TID.
    let containerInfo;
    let tid: string;
    try {
      containerInfo = await ctx.containerManager.spawnTeamContainer(parsed.slug, workspacePath);
      tid = containerInfo.tid;
    } catch (err) {
      ctx.logger.error('Failed to spawn team container', {
        slug: parsed.slug,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    // Persist TID to team.yaml so rebuildTeamsFromFilesystem can restore it
    try {
      const fs = await import('node:fs/promises');
      const nodePath = await import('node:path');
      const yamlMod = await import('yaml');
      const teamYamlPath = nodePath.join(workspacePath, 'team.yaml');
      let teamYamlContent: Record<string, unknown> = {};
      try {
        const raw = await fs.readFile(teamYamlPath, 'utf-8');
        teamYamlContent = (yamlMod.parse(raw) as Record<string, unknown>) ?? {};
      } catch {
        // team.yaml may not exist yet if scaffolding didn't create one
      }
      teamYamlContent.tid = tid;
      if (!teamYamlContent.slug) teamYamlContent.slug = parsed.slug;
      await fs.writeFile(teamYamlPath, yamlMod.stringify(teamYamlContent), 'utf-8');
    } catch (err) {
      ctx.logger.warn('Failed to persist TID to team.yaml', {
        tid,
        slug: parsed.slug,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Add team to org chart with the container's TID
    ctx.orgChart.addTeam({
      tid,
      slug: parsed.slug,
      parentTid,
      depth: parentDepth + 1,
      containerId: containerInfo.id,
      health: containerInfo.health,
      agentAids: [],
      workspacePath,
    });

    ctx.eventBus.publish({
      type: 'team.created',
      data: { tid, slug: parsed.slug },
      timestamp: Date.now(),
      source: agentAid,
    });

    // Wait for container ready handshake (timeout: 60 seconds)
    const timeoutMs = 60_000;
    const pollIntervalMs = 500;
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      if (ctx.wsHub.isReady(tid)) {
        ctx.logger.info('Team container ready', { tid, container_id: containerInfo.id });
        return { slug: parsed.slug, tid, container_id: containerInfo.id, status: 'running' };
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    // Timeout - container started but not ready yet
    ctx.logger.warn('Team container started but not ready within timeout', {
      tid,
      container_id: containerInfo.id,
      timeout_ms: timeoutMs,
    });
    return { slug: parsed.slug, tid, container_id: containerInfo.id, status: 'starting' };
  });

  handlers.set('create_agent', async (args, agentAid) => {
    const parsed = CreateAgentSchema.parse(args);

    const team = ctx.orgChart.getTeamBySlug(parsed.team_slug);
    if (!team) {
      throw new NotFoundError(`Team '${parsed.team_slug}' not found`);
    }

    // CON-03: Enforce max agents per team
    const existingAgents = ctx.orgChart.getAgentsByTeam(parsed.team_slug);
    if (existingAgents.length >= ctx.limits.max_agents_per_team) {
      ctx.logger.audit('security.limit_breach', {
        type: 'max_agents_per_team',
        current: existingAgents.length,
        limit: ctx.limits.max_agents_per_team,
        team_slug: parsed.team_slug,
        agent_aid: agentAid,
      });
      throw new ValidationError(
        `Team '${parsed.team_slug}' already has ${existingAgents.length} agents (max: ${ctx.limits.max_agents_per_team})`
      );
    }

    const aid = generateId('aid', parsed.name);

    // All agent definitions go to the team workspace
    const agentRole = 'member' as const;
    const definitionPath = team.workspacePath;

    // Write agent definition file
    if (ctx.workspaceLock) {
      await ctx.workspaceLock.acquire(definitionPath);
    }
    try {
      await ctx.provisioner.writeAgentDefinition(definitionPath, {
        aid,
        name: parsed.name,
        description: parsed.description,
        model: parsed.model,
        tools: [],
        content: parsed.description,
      });
      // Update team.yaml so the agent survives container restart
      const teamWorkspacePath = team.workspacePath;
      await ctx.provisioner.addAgentToTeamYaml(teamWorkspacePath, {
        aid,
        name: parsed.name,
        description: parsed.description,
        model_tier: parsed.model ?? 'sonnet',
        role: agentRole,
        provider: 'default',
      });
    } finally {
      if (ctx.workspaceLock) {
        ctx.workspaceLock.release(definitionPath);
      }
    }
    ctx.orgChart.addAgent({
      aid,
      name: parsed.name,
      teamSlug: parsed.team_slug,
      role: agentRole,
      status: AgentStatus.Idle,
      modelTier: parsed.model,
    });

    return { aid, role: agentRole };
  });

  return handlers;
}
