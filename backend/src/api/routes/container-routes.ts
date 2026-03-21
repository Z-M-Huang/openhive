/**
 * Container management routes.
 *
 * @module api/routes/container-routes
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ContainerHealth } from '../../domain/enums.js';
import { NotFoundError, ValidationError, ConflictError } from '../../domain/errors.js';
import { containerRestartParamsSchema, getRestartCount } from './types.js';
import type { RouteContext } from './types.js';

export function registerContainerRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/api/containers', async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.containerManager) {
      reply.code(503).send({ error: 'ContainerManager not available' });
      return;
    }

    const containers = await ctx.containerManager.listRunningContainers();
    const now = Date.now();

    const result = await Promise.all(
      containers.map(async (c) => {
        const slug = c.teamSlug;

        let health: ContainerHealth = c.health;
        if (ctx.healthMonitor) {
          health = ctx.healthMonitor.getHealth(c.tid);
        }

        const agentCount = ctx.orgChart ? ctx.orgChart.getAgentsByTeam(slug).length : 0;
        const uptimeSeconds = Math.floor((now - c.createdAt) / 1000);
        const restartCount = getRestartCount(ctx.containerManager!, slug);

        let activeTaskCount = 0;
        if (ctx.taskStore) {
          const teamTasks = await ctx.taskStore.listByTeam(slug);
          activeTaskCount = teamTasks.filter((t) => t.status === 'active').length;
        }

        let childTeams: string[] = [];
        if (ctx.orgChart) {
          const team = ctx.orgChart.getTeamBySlug(slug);
          if (team) {
            childTeams = ctx.orgChart.getChildren(team.tid).map((child) => child.slug);
          }
        }

        return {
          slug,
          health,
          agentCount,
          uptime: uptimeSeconds,
          restartCount,
          activeTaskCount,
          childTeams,
        };
      }),
    );

    reply.send({ containers: result });
  });

  app.post('/api/containers/:slug/restart', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.containerManager) {
      reply.code(503).send({ error: 'ContainerManager not available' });
      return;
    }

    const paramsParseResult = containerRestartParamsSchema.safeParse(request.params);
    if (!paramsParseResult.success) {
      reply.code(400).send({ error: 'Invalid route parameter', details: paramsParseResult.error.issues });
      return;
    }
    const { slug } = paramsParseResult.data;

    try {
      await ctx.containerManager.restartTeamContainer(slug, 'api_restart');
      ctx.logger?.audit('container.restart.api', { slug, source: 'api' });
      reply.send({ slug, status: 'restarted' });
    } catch (err) {
      if (err instanceof ConflictError) {
        reply.code(409).send({ error: err.message });
        return;
      }
      if (err instanceof NotFoundError) {
        reply.code(404).send({ error: err.message });
        return;
      }
      if (err instanceof ValidationError) {
        reply.code(400).send({ error: err.message });
        return;
      }
      throw err;
    }
  });
}
