/**
 * OpenHive Backend - Team API Handlers
 *
 * Implements GET /api/v1/teams, GET /api/v1/teams/:slug,
 * POST /api/v1/teams, DELETE /api/v1/teams/:slug.
 * Team responses include optional heartbeat status.
 * Slug param schema prevents path traversal and invalid characters.
 *
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Orchestrator, HeartbeatMonitor, OrgChart } from '../domain/interfaces.js';
import type { Agent, HeartbeatStatus, Team } from '../domain/types.js';
import { isReservedSlug, validateSlug } from '../domain/validation.js';
import type { MiddlewareLogger } from './middleware.js';
import { mapDomainError, sendError, sendJSON } from './response.js';
import type { FastifyReplyShim } from './response.js';

// ---------------------------------------------------------------------------
// Response type
// ---------------------------------------------------------------------------

/** Team safe for API output (includes optional heartbeat). */
export interface TeamResponse {
  slug: string;
  tid: string;
  leader_aid: string;
  parent_slug?: string;
  children?: string[];
  agents?: Agent[];
  heartbeat?: HeartbeatStatus;
}

// ---------------------------------------------------------------------------
// Request / param types (internal)
// ---------------------------------------------------------------------------

interface CreateTeamRequest {
  slug: string;
  leader_aid: string;
}

interface SlugParams {
  slug: string;
}

// ---------------------------------------------------------------------------
// JSON schemas for Fastify validation
// ---------------------------------------------------------------------------

/** Shared slug pattern: lowercase letters, numbers, hyphens. No dots, slashes, spaces. */
const SLUG_PATTERN = '^[a-z0-9][a-z0-9-]*[a-z0-9]$';

/** JSON schema for the :slug URL parameter. */
export const SLUG_PARAM_SCHEMA = {
  params: {
    type: 'object',
    properties: {
      slug: { type: 'string', pattern: SLUG_PATTERN, maxLength: 64 },
    },
  },
};

/** JSON schema for POST /api/v1/teams request body. */
export const CREATE_TEAM_SCHEMA = {
  body: {
    type: 'object',
    required: ['slug', 'leader_aid'],
    additionalProperties: false,
    properties: {
      slug: { type: 'string', pattern: SLUG_PATTERN, minLength: 2, maxLength: 64 },
      leader_aid: { type: 'string', pattern: '^aid-[a-z0-9-]+$', maxLength: 128 },
    },
  },
};

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Builds a TeamResponse from a Team, optionally populating heartbeat status.
 * If hbm is null or getStatus throws (team not yet seen), heartbeat is omitted.
 */
export function buildTeamResponse(team: Team, hbm: HeartbeatMonitor | null): TeamResponse {
  const resp: TeamResponse = {
    slug: team.slug,
    tid: team.tid,
    leader_aid: team.leader_aid,
    parent_slug: team.parent_slug,
    children: team.children,
    agents: team.agents,
  };

  if (hbm !== null) {
    try {
      resp.heartbeat = hbm.getStatus(team.tid);
    } catch {
      // No heartbeat recorded yet for this team — omit the field.
    }
  }

  return resp;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * Handler factory for GET /api/v1/teams.
 * Returns all teams from the org chart with optional heartbeat status.
 */
export function getTeamsHandler(
  orgChart: OrgChart,
  hbm: HeartbeatMonitor | null,
  _logger: MiddlewareLogger,
) {
  return async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const teamsMap = orgChart.getOrgChart();
    const result: TeamResponse[] = [];
    for (const team of Object.values(teamsMap)) {
      result.push(buildTeamResponse(team, hbm));
    }
    sendJSON(reply as FastifyReplyShim, 200, result);
  };
}

/**
 * Handler factory for GET /api/v1/teams/:slug.
 * Returns a single team by slug. Returns 404 if not found.
 * Slug is validated by the Fastify param schema before this handler runs.
 */
export function getTeamHandler(
  orgChart: OrgChart,
  hbm: HeartbeatMonitor | null,
  _logger: MiddlewareLogger,
) {
  return async (
    request: FastifyRequest<{ Params: SlugParams }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const { slug } = request.params;
    try {
      const team = orgChart.getTeamBySlug(slug);
      sendJSON(reply as FastifyReplyShim, 200, buildTeamResponse(team, hbm));
    } catch (err) {
      mapDomainError(reply as FastifyReplyShim, err);
    }
  };
}

/**
 * Handler factory for POST /api/v1/teams.
 * Creates a new team after domain validation.
 * Body schema is validated by Fastify before this handler is invoked.
 */
export function createTeamHandler(orch: Orchestrator, logger: MiddlewareLogger) {
  return async (
    request: FastifyRequest<{ Body: CreateTeamRequest }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const { slug, leader_aid } = request.body;

    // Domain-level slug validation (path traversal, slug pattern, length).
    try {
      validateSlug(slug);
    } catch (err) {
      mapDomainError(reply as FastifyReplyShim, err);
      return;
    }

    if (isReservedSlug(slug)) {
      sendError(
        reply as FastifyReplyShim,
        400,
        'VALIDATION_ERROR',
        `slug "${slug}" is reserved and cannot be used as a team name`,
      );
      return;
    }

    try {
      const team = await orch.createTeam(slug, leader_aid);
      sendJSON(reply as FastifyReplyShim, 201, team);
    } catch (err) {
      logger.error('failed to create team', err);
      mapDomainError(reply as FastifyReplyShim, err);
    }
  };
}

/**
 * Handler factory for DELETE /api/v1/teams/:slug.
 * Deletes a team by slug. Returns 204 on success, 404 if not found.
 * Slug param is validated by the Fastify param schema before this handler runs.
 */
export function deleteTeamHandler(orch: Orchestrator, logger: MiddlewareLogger) {
  return async (
    request: FastifyRequest<{ Params: SlugParams }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const { slug } = request.params;
    try {
      await orch.deleteTeam(slug);
      reply.code(204).send();
    } catch (err) {
      logger.error('failed to delete team', err);
      mapDomainError(reply as FastifyReplyShim, err);
    }
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Registers all team routes on the Fastify instance.
 * Attaches JSON schemas for param and body validation.
 */
export function registerTeamRoutes(
  fastify: FastifyInstance,
  orgChart: OrgChart,
  orch: Orchestrator,
  hbm: HeartbeatMonitor | null,
  logger: MiddlewareLogger,
): void {
  fastify.get('/api/v1/teams', getTeamsHandler(orgChart, hbm, logger));
  fastify.get(
    '/api/v1/teams/:slug',
    { schema: SLUG_PARAM_SCHEMA },
    getTeamHandler(orgChart, hbm, logger),
  );
  fastify.post(
    '/api/v1/teams',
    { schema: CREATE_TEAM_SCHEMA },
    createTeamHandler(orch, logger),
  );
  fastify.delete(
    '/api/v1/teams/:slug',
    { schema: SLUG_PARAM_SCHEMA },
    deleteTeamHandler(orch, logger),
  );
}
