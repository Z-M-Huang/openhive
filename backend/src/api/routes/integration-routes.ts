/**
 * Integration query routes.
 *
 * @module api/routes/integration-routes
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { teamFilterSchema } from './types.js';
import type { RouteContext } from './types.js';

export function registerIntegrationRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/api/integrations', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.integrationStore) {
      reply.code(503).send({ error: 'IntegrationStore not available' });
      return;
    }

    const queryParseResult = teamFilterSchema.safeParse(request.query);
    if (!queryParseResult.success) {
      reply.code(400).send({ error: 'Invalid query parameters', details: queryParseResult.error.issues });
      return;
    }
    const query = queryParseResult.data;

    const { integrations: rawIntegrations } = await (async () => {
      if (query.team) {
        const list = await ctx.integrationStore!.listByTeam(query.team);
        return { integrations: list };
      }

      const teams = ctx.orgChart ? ctx.orgChart.listTeams() : [];
      const all = await Promise.all(teams.map((t) => ctx.integrationStore!.listByTeam(t.slug)));
      return { integrations: all.flat() };
    })();

    const integrations = rawIntegrations.map((i) => {
      const teamSlug = ctx.orgChart?.getTeam(i.team_id)?.slug ?? i.team_id;
      return {
        id: i.id,
        name: i.name,
        teamSlug,
        config_path: i.config_path,
        status: i.status,
        error_message: i.error_message,
        created_at: i.created_at,
      };
    });

    reply.send({ integrations });
  });
}
