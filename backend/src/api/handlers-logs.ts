/**
 * OpenHive Backend - Log Viewer API Handler
 *
 * Implements GET /api/v1/logs with query params:
 * level, component, team, agent, task_id, since, until, limit, offset.
 * Returns empty array instead of null.
 *
 * Note: ajv-formats is not installed, so format:'date-time' is an annotation
 * only. since/until are validated manually in the handler.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { LogStore } from '../domain/interfaces.js';
import type { LogEntry, LogQueryOpts } from '../domain/types.js';
import type { LogLevel } from '../domain/enums.js';
import type { MiddlewareLogger } from './middleware.js';
import { sendError, sendJSON } from './response.js';
import type { FastifyReplyShim } from './response.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LOGS_LIMIT = 100;
const MAX_LOGS_LIMIT = 1000;

// ---------------------------------------------------------------------------
// Internal request types
// ---------------------------------------------------------------------------

interface GetLogsQuery {
  level?: LogLevel;
  component?: string;
  team?: string;
  agent?: string;
  task_id?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// JSON schema
// ---------------------------------------------------------------------------

/**
 * JSON schema for GET /api/v1/logs querystring.
 * since/until use type:'string' — date-time validation is done in the handler
 * because ajv-formats is not installed (format keyword is annotation-only).
 */
export const GET_LOGS_QUERY_SCHEMA = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      level: {
        type: 'string',
        enum: ['debug', 'info', 'warn', 'error'],
      },
      component: {
        type: 'string',
        maxLength: 128,
        pattern: '^[a-zA-Z0-9._-]+$',
      },
      team: {
        type: 'string',
        pattern: '^[a-z0-9][a-z0-9-]*[a-z0-9]$',
        maxLength: 64,
      },
      agent: {
        type: 'string',
        maxLength: 128,
      },
      task_id: {
        type: 'string',
        pattern: '^[a-f0-9-]+$',
        maxLength: 128,
      },
      since: { type: 'string' },
      until: { type: 'string' },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_LOGS_LIMIT,
        default: DEFAULT_LOGS_LIMIT,
      },
      offset: {
        type: 'integer',
        minimum: 0,
        default: 0,
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * Handler factory for GET /api/v1/logs.
 */
export function getLogsHandler(logStore: LogStore, logger: MiddlewareLogger) {
  return async (
    request: FastifyRequest<{ Querystring: GetLogsQuery }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const { level, component, team, agent, task_id } = request.query;
    const limit = request.query.limit ?? DEFAULT_LOGS_LIMIT;
    const offset = request.query.offset ?? 0;

    const opts: LogQueryOpts = { level, component, team_name: team, agent_name: agent, task_id, limit, offset };

    // Validate and parse since
    if (request.query.since !== undefined) {
      const d = new Date(request.query.since);
      if (isNaN(d.getTime())) {
        sendError(reply as FastifyReplyShim, 400, 'INVALID_PARAM', 'since must be a valid date-time string');
        return;
      }
      opts.since = d;
    }

    // Validate and parse until
    if (request.query.until !== undefined) {
      const d = new Date(request.query.until);
      if (isNaN(d.getTime())) {
        sendError(reply as FastifyReplyShim, 400, 'INVALID_PARAM', 'until must be a valid date-time string');
        return;
      }
      opts.until = d;
    }

    let entries: LogEntry[];
    try {
      entries = await logStore.query(opts);
    } catch (err) {
      logger.error('failed to query logs', err);
      sendError(reply as FastifyReplyShim, 500, 'INTERNAL_ERROR', 'failed to query logs');
      return;
    }

    // Return empty array rather than null
    sendJSON(reply as FastifyReplyShim, 200, entries ?? []);
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Registers all log routes on the Fastify instance.
 */
export function registerLogRoutes(
  fastify: FastifyInstance,
  logStore: LogStore,
  logger: MiddlewareLogger,
): void {
  fastify.get('/api/v1/logs', { schema: GET_LOGS_QUERY_SCHEMA }, getLogsHandler(logStore, logger));
}
