/**
 * Agent listing routes.
 *
 * @module api/routes/agent-routes
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { teamFilterSchema } from './types.js';
import type { RouteContext } from './types.js';

export function registerAgentRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/api/agents', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.orgChart) {
      reply.code(503).send({ error: 'OrgChart not available' });
      return;
    }

    const queryParseResult = teamFilterSchema.safeParse(request.query);
    if (!queryParseResult.success) {
      reply.code(400).send({ error: 'Invalid query parameters', details: queryParseResult.error.issues });
      return;
    }
    const query = queryParseResult.data;

    let agents;
    if (query.team) {
      agents = ctx.orgChart.getAgentsByTeam(query.team);
    } else {
      const allTeams = ctx.orgChart.listTeams();
      agents = allTeams.flatMap((team) => ctx.orgChart!.getAgentsByTeam(team.slug));
    }

    reply.send({
      agents: agents.map((a) => ({
        aid: a.aid,
        name: a.name,
        teamSlug: a.teamSlug,
        role: a.role,
        status: a.status,
        modelTier: a.modelTier ?? null,
      })),
    });
  });
}
