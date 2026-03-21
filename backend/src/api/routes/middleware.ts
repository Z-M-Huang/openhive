/**
 * Infrastructure-level middleware for the Fastify instance.
 *
 * @module api/routes/middleware
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { RouteContext } from './types.js';

/**
 * Register infrastructure-level middleware on the Fastify instance.
 *
 * Applies a 1 MB body limit for all regular endpoints and registers an
 * `onError` hook that sanitizes 5xx responses (AC-G15).
 */
export function registerMiddleware(app: FastifyInstance, ctx: RouteContext): void {
  // 1 MB body limit for all endpoints (AC-G14)
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string', bodyLimit: 1_048_576 },
    (_req, body, done) => {
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // Sanitize 5xx error responses: log full error, return correlation ID (AC-G15)
  app.addHook('onError', async (_request: FastifyRequest, reply: FastifyReply, error: Error) => {
    const correlationId = randomUUID();
    ctx.logger?.error('Unhandled API error', {
      correlation_id: correlationId,
      error: error.message,
      stack: error.stack,
    });
    if (reply.statusCode >= 500) {
      reply.code(500).send({
        error: 'Internal server error',
        correlationId,
      });
    }
  });
}
