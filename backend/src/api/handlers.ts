/**
 * OpenHive Backend - Core API Handlers
 *
 * healthHandler  — uptime + optional dropped log count
 * unlockHandler  — key manager unlock endpoint
 * notFoundHandler — 404 JSON for unmatched routes
 *
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import type { KeyManager } from '../domain/interfaces.js';
import { sendJSON, sendError, mapDomainError } from './response.js';

// ---------------------------------------------------------------------------
// DroppedLogCounter interface
// ---------------------------------------------------------------------------

/**
 * Provides the count of dropped log entries.
 */
export interface DroppedLogCounter {
  droppedCount(): number;
}

// ---------------------------------------------------------------------------
// Duration formatter
// ---------------------------------------------------------------------------

/** Formats milliseconds as a compact duration string, e.g. "3h2m15s". */
function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${String(hours)}h${String(minutes)}m${String(seconds)}s`;
  if (minutes > 0) return `${String(minutes)}m${String(seconds)}s`;
  return `${String(seconds)}s`;
}

// ---------------------------------------------------------------------------
// healthHandler
// ---------------------------------------------------------------------------

/**
 * Returns a Fastify route handler for GET /health.
 * Response: { status, version, uptime, dropped_log_entries? }
 */
export function healthHandler(
  startTime: Date,
  dbLogger?: DroppedLogCounter,
): (request: FastifyRequest, reply: FastifyReply) => void {
  return (_request: FastifyRequest, reply: FastifyReply) => {
    const uptime = formatDuration(Date.now() - startTime.getTime());
    const body: Record<string, unknown> = {
      status: 'ok',
      version: '0.1.0',
      uptime,
    };
    if (dbLogger !== undefined) {
      body['dropped_log_entries'] = dbLogger.droppedCount();
    }
    sendJSON(reply as Parameters<typeof sendJSON>[0], 200, body);
  };
}

// ---------------------------------------------------------------------------
// unlockHandler
// ---------------------------------------------------------------------------

interface UnlockRequest {
  master_key?: unknown;
}

/**
 * Returns a Fastify route handler for POST /unlock.
 * Parses { master_key }, calls km.unlock(), returns { status: 'unlocked' }.
 */
export function unlockHandler(
  km: KeyManager,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as UnlockRequest | undefined;
    const masterKey = body?.master_key;

    if (typeof masterKey !== 'string' || masterKey === '') {
      sendError(reply as Parameters<typeof sendError>[0], 400, 'VALIDATION_ERROR', 'master_key is required');
      return;
    }

    try {
      await km.unlock(masterKey);
    } catch (err) {
      mapDomainError(reply as Parameters<typeof mapDomainError>[0], err);
      return;
    }

    sendJSON(reply as Parameters<typeof sendJSON>[0], 200, { status: 'unlocked' });
  };
}

// ---------------------------------------------------------------------------
// notFoundHandler
// ---------------------------------------------------------------------------

/**
 * Returns a Fastify route handler for unmatched routes.
 * Returns 404 JSON error.
 */
export function notFoundHandler(): (request: FastifyRequest, reply: FastifyReply) => void {
  return (_request: FastifyRequest, reply: FastifyReply) => {
    sendError(
      reply as Parameters<typeof sendError>[0],
      404,
      'NOT_FOUND',
      'the requested resource was not found',
    );
  };
}
