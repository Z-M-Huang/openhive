/**
 * OpenHive Backend - API Response Helpers
 *
 * JSON success/error response helpers and domain error → HTTP status mapping.
 * Wire format:
 *   Success: { "data": <payload> }
 *   Error:   { "error": { "code": "...", "message": "..." } }
 *
 */

import {
  NotFoundError,
  ValidationError,
  ConflictError,
  EncryptionLockedError,
  RateLimitedError,
} from '../domain/errors.js';

// ---------------------------------------------------------------------------
// Fastify shim types
// ---------------------------------------------------------------------------

/** Minimal Fastify reply interface needed by response helpers. */
export interface FastifyReplyShim {
  code(statusCode: number): FastifyReplyShim;
  header(name: string, value: string): FastifyReplyShim;
  send(payload: unknown): void;
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

interface SuccessEnvelope<T> {
  data: T;
}

interface ErrorBody {
  code: string;
  message: string;
}

interface ErrorEnvelope {
  error: ErrorBody;
}

// ---------------------------------------------------------------------------
// sendJSON — success response
// ---------------------------------------------------------------------------

/**
 * Writes a JSON success response wrapped in { data: ... }.
 */
export function sendJSON<T>(reply: FastifyReplyShim, status: number, data: T): void {
  const envelope: SuccessEnvelope<T> = { data };
  reply.code(status).send(envelope);
}

// ---------------------------------------------------------------------------
// sendError — error response
// ---------------------------------------------------------------------------

/**
 * Writes a JSON error response wrapped in { error: { code, message } }.
 */
export function sendError(
  reply: FastifyReplyShim,
  status: number,
  code: string,
  message: string,
): void {
  const envelope: ErrorEnvelope = { error: { code, message } };
  reply.code(status).send(envelope);
}

// ---------------------------------------------------------------------------
// mapDomainError — domain error → HTTP status
// ---------------------------------------------------------------------------

/**
 * Maps domain errors to appropriate HTTP status codes and writes the response.
 * Mapping:
 *   NotFoundError         → 404 NOT_FOUND
 *   ValidationError       → 400 VALIDATION_ERROR
 *   ConflictError         → 409 CONFLICT
 *   EncryptionLockedError → 403 ENCRYPTION_LOCKED
 *   RateLimitedError      → 429 RATE_LIMITED (+ Retry-After header)
 *   default               → 500 INTERNAL_ERROR
 */
export function mapDomainError(reply: FastifyReplyShim, err: unknown): void {
  if (err instanceof NotFoundError) {
    sendError(reply, 404, err.code, 'the requested resource was not found');
    return;
  }

  if (err instanceof ValidationError) {
    sendError(reply, 400, err.code, err.message);
    return;
  }

  if (err instanceof ConflictError) {
    sendError(reply, 409, err.code, 'a resource conflict occurred');
    return;
  }

  if (err instanceof EncryptionLockedError) {
    sendError(reply, 403, err.code, 'encryption is locked');
    return;
  }

  if (err instanceof RateLimitedError) {
    reply.header('Retry-After', String(err.retryAfterSeconds));
    sendError(reply, 429, err.code, 'rate limit exceeded');
    return;
  }

  sendError(reply, 500, 'INTERNAL_ERROR', 'an internal error occurred');
}

// ---------------------------------------------------------------------------
// maskSecret — redact sensitive strings for display
// ---------------------------------------------------------------------------

/**
 * Returns a masked version of a secret string: '****' + last 4 characters.
 * If the string is 4 characters or shorter, returns '****'.
 *
 * Example: maskSecret('my-api-key-xyz') → '****-xyz'
 * Example: maskSecret('abcd') → '****'
 */
export function maskSecret(s: string): string {
  if (s.length <= 4) {
    return '****';
  }
  return '****' + s.slice(-4);
}
