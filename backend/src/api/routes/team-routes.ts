/**
 * Team management routes.
 *
 * @module api/routes/team-routes
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { NotFoundError, ValidationError, ConflictError } from '../../domain/errors.js';
import { createTeamBodySchema } from './types.js';
import type { RouteContext } from './types.js';

export function registerTeamRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/api/teams', async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.orgChart) {
      reply.code(503).send({ error: 'OrgChart not available' });
      return;
    }

    const teams = ctx.orgChart.listTeams();
    const result = teams.map((team) => {
      const agents = ctx.orgChart!.getAgentsByTeam(team.slug);
      let parentSlug: string | null = null;
      if (team.parentTid) {
        const parent = ctx.orgChart!.getParent(team.tid);
        parentSlug = parent?.slug ?? null;
      }
      return {
        tid: team.tid,
        slug: team.slug,
        coordinatorAid: team.coordinatorAid ?? null,
        health: team.health,
        agentCount: agents.length,
        depth: team.depth,
        parentSlug,
      };
    });

    reply.send({ teams: result });
  });

  app.get('/api/teams/:slug', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.orgChart) {
      reply.code(503).send({ error: 'OrgChart not available' });
      return;
    }

    const { slug } = request.params as { slug: string };
    const team = ctx.orgChart.getTeamBySlug(slug);

    if (!team) {
      reply.code(404).send({ error: `Team not found: ${slug}` });
      return;
    }

    const agents = ctx.orgChart.getAgentsByTeam(slug);
    const children = ctx.orgChart.getChildren(team.tid);

    reply.send({
      tid: team.tid,
      slug: team.slug,
      coordinatorAid: team.coordinatorAid ?? null,
      health: team.health,
      depth: team.depth,
      containerId: team.containerId,
      workspacePath: team.workspacePath,
      agents: agents.map((a) => ({
        aid: a.aid,
        name: a.name,
        role: a.role,
        status: a.status,
      })),
      childTeams: children.map((c) => c.slug),
    });
  });

  app.post('/api/teams', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.containerManager) {
      reply.code(503).send({ error: 'ContainerManager not available' });
      return;
    }

    const parseResult = createTeamBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.code(400).send({ error: 'Invalid request body', details: parseResult.error.issues });
      return;
    }
    const body = parseResult.data;

    try {
      if (ctx.provisioner) {
        const parentPath = '/app/workspace';
        await ctx.provisioner.scaffoldWorkspace(parentPath, body.slug);
      }

      const container = await ctx.containerManager.spawnTeamContainer(body.slug);

      if (ctx.orgChart) {
        const parentTeam = ctx.orgChart.getTeamBySlug('main');
        ctx.orgChart.addTeam({
          tid: container.tid,
          slug: body.slug,
          parentTid: parentTeam?.tid ?? '',
          depth: (parentTeam?.depth ?? 0) + 1,
          containerId: container.id,
          health: container.health ?? 'starting',
          agentAids: [],
          workspacePath: `/app/workspace/teams/${body.slug}`,
        });
      }

      if (ctx.eventBus) {
        ctx.eventBus.publish({
          type: 'team.created',
          data: { tid: container.tid, slug: body.slug },
          timestamp: Date.now(),
          source: 'api',
        });
      }

      reply.code(201).send({
        slug: body.slug,
        tid: container.tid,
        containerId: container.id,
        status: 'created',
      });
    } catch (err) {
      if (err instanceof ValidationError || err instanceof ConflictError) {
        reply.code(400).send({ error: (err as Error).message });
        return;
      }
      if (err instanceof Error && (
        err.message.includes('Reserved slug') ||
        err.message.includes('Invalid slug') ||
        err.message.includes('Slug too')
      )) {
        reply.code(400).send({ error: err.message });
        return;
      }
      throw err;
    }
  });

  app.delete('/api/teams/:slug', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.containerManager) {
      reply.code(503).send({ error: 'ContainerManager not available' });
      return;
    }

    const { slug } = request.params as { slug: string };

    try {
      // Stop container (may not exist for rebuilt-from-filesystem teams)
      try {
        await ctx.containerManager.stopTeamContainer(slug, 'api_delete');
      } catch (stopErr) {
        if (!(stopErr instanceof NotFoundError)) throw stopErr;
        // Container not running — proceed with org chart cleanup
      }

      if (ctx.orgChart) {
        const team = ctx.orgChart.getTeamBySlug(slug);
        if (team) {
          ctx.orgChart.removeTeam(team.tid);
        } else {
          reply.code(404).send({ error: `Team not found: ${slug}` });
          return;
        }
      }

      reply.send({ slug, status: 'removed' });
    } catch (err) {
      if (err instanceof NotFoundError) {
        reply.code(404).send({ error: `Team not found: ${slug}` });
        return;
      }
      throw err;
    }
  });
}
