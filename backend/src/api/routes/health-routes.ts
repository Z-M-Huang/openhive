/**
 * Health check routes.
 *
 * @module api/routes/health-routes
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ContainerHealth } from '../../domain/enums.js';
import type { RouteContext } from './types.js';

export function registerHealthRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/api/health', async (_request: FastifyRequest, reply: FastifyReply) => {
    const uptime = process.uptime();
    const containers = ctx.containerManager
      ? (await ctx.containerManager.listRunningContainers()).length
      : 0;
    const connectedTeams = ctx.orgChart
      ? ctx.orgChart.listTeams().map((t) => t.slug)
      : [];

    let status = 'healthy';
    if (ctx.healthMonitor) {
      const healthMap = ctx.healthMonitor.getAllHealth();
      for (const [, health] of healthMap) {
        if (health === ContainerHealth.Unhealthy || health === ContainerHealth.Unreachable) {
          status = 'degraded';
          break;
        }
      }
    }

    reply.send({
      status,
      uptime: Math.floor(uptime),
      containers,
      connectedTeams,
      dbStatus: 'connected',
    });
  });
}
