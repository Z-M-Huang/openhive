/**
 * Container tool handlers: spawn_container, stop_container, list_containers.
 *
 * @module mcp/tools/handlers-container
 */

import { ContainerHealth } from '../../domain/index.js';
import { SpawnContainerSchema, StopContainerSchema } from './schemas.js';
import type { ToolContext, ToolHandler } from './types.js';

export function createContainerHandlers(ctx: ToolContext): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  handlers.set('spawn_container', async (args) => {
    const parsed = SpawnContainerSchema.parse(args);
    const info = await ctx.containerManager.spawnTeamContainer(parsed.team_slug);
    return {
      container_id: info.id,
      connected: info.health !== ContainerHealth.Unreachable,
    };
  });

  handlers.set('stop_container', async (args) => {
    const parsed = StopContainerSchema.parse(args);

    // Look up workspace path before stopping (org chart entry may be removed after)
    const stoppingTeam = ctx.orgChart.getTeamBySlug(parsed.team_slug);
    const teamWorkspacePath = stoppingTeam?.workspacePath;

    await ctx.containerManager.stopTeamContainer(parsed.team_slug, 'Tool: stop_container');

    // Only delete workspace if explicitly requested (default: preserve files)
    if (parsed.delete_workspace && teamWorkspacePath) {
      if (ctx.workspaceLock) {
        await ctx.workspaceLock.acquire(teamWorkspacePath);
      }
      try {
        await ctx.provisioner.deleteWorkspace(teamWorkspacePath);
      } finally {
        if (ctx.workspaceLock) {
          ctx.workspaceLock.release(teamWorkspacePath);
        }
      }
    }

    return {
      message: `Container for team '${parsed.team_slug}' stopped`,
      final_status: 'stopped',
      workspace_deleted: !!parsed.delete_workspace,
    };
  });

  handlers.set('list_containers', async () => {
    const containers = await ctx.containerManager.listRunningContainers();
    return {
      containers: containers.map((c) => ({
        container_id: c.id,
        team_slug: c.teamSlug,
        health: c.health,
        created_at: c.createdAt,
      })),
    };
  });

  return handlers;
}
