/**
 * Tests for API response helpers.
 */

import { describe, expect, it } from 'vitest';

import {
  ConflictError,
  EncryptionLockedError,
  NotFoundError,
  RateLimitedError,
  ValidationError,
} from '../domain/errors.js';
import { mapDomainError, maskSecret, sendError, sendJSON } from './response.js';
import type { FastifyReplyShim } from './response.js';

// ---------------------------------------------------------------------------
// Helper: mock FastifyReplyShim that captures calls
// ---------------------------------------------------------------------------

interface CapturedReply {
  status: number;
  payload: unknown;
  headers: Record<string, string>;
}

function makeMockReply(): { reply: FastifyReplyShim; captured: CapturedReply } {
  const captured: CapturedReply = { status: 0, payload: undefined, headers: {} };

  const reply: FastifyReplyShim = {
    code(statusCode: number) {
      captured.status = statusCode;
      return reply;
    },
    header(name: string, value: string) {
      captured.headers[name] = value;
      return reply;
    },
    send(payload: unknown) {
      captured.payload = payload;
    },
  };

  return { reply, captured };
}

// ---------------------------------------------------------------------------
// sendJSON
// ---------------------------------------------------------------------------

describe('sendJSON', () => {
  it('wraps data in success envelope { data: ... }', () => {
    const { reply, captured } = makeMockReply();

    sendJSON(reply, 200, { id: 'abc', name: 'test' });

    expect(captured.status).toBe(200);
    expect(captured.payload).toEqual({ data: { id: 'abc', name: 'test' } });
  });

  it('works with non-200 status codes', () => {
    const { reply, captured } = makeMockReply();

    sendJSON(reply, 201, { created: true });

    expect(captured.status).toBe(201);
    expect(captured.payload).toEqual({ data: { created: true } });
  });
});

// ---------------------------------------------------------------------------
// sendError
// ---------------------------------------------------------------------------

describe('sendError', () => {
  it('wraps error in error envelope { error: { code, message } }', () => {
    const { reply, captured } = makeMockReply();

    sendError(reply, 400, 'VALIDATION_ERROR', 'field is required');

    expect(captured.status).toBe(400);
    expect(captured.payload).toEqual({
      error: { code: 'VALIDATION_ERROR', message: 'field is required' },
    });
  });
});

// ---------------------------------------------------------------------------
// mapDomainError
// ---------------------------------------------------------------------------

describe('mapDomainError', () => {
  it('maps NotFoundError to 404 NOT_FOUND', () => {
    const { reply, captured } = makeMockReply();

    mapDomainError(reply, new NotFoundError('agent', 'aid-123'));

    expect(captured.status).toBe(404);
    expect((captured.payload as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('maps ValidationError to 400 VALIDATION_ERROR with original message', () => {
    const { reply, captured } = makeMockReply();

    mapDomainError(reply, new ValidationError('name', 'must not be empty'));

    expect(captured.status).toBe(400);
    const payload = captured.payload as { error: { code: string; message: string } };
    expect(payload.error.code).toBe('VALIDATION_ERROR');
    expect(payload.error.message).toContain('must not be empty');
  });

  it('maps ConflictError to 409 CONFLICT', () => {
    const { reply, captured } = makeMockReply();

    mapDomainError(reply, new ConflictError('team', 'already exists'));

    expect(captured.status).toBe(409);
    expect((captured.payload as { error: { code: string } }).error.code).toBe('CONFLICT');
  });

  it('maps EncryptionLockedError to 403 ENCRYPTION_LOCKED', () => {
    const { reply, captured } = makeMockReply();

    mapDomainError(reply, new EncryptionLockedError('key is locked'));

    expect(captured.status).toBe(403);
    expect((captured.payload as { error: { code: string } }).error.code).toBe('ENCRYPTION_LOCKED');
  });

  it('maps RateLimitedError to 429 with Retry-After header', () => {
    const { reply, captured } = makeMockReply();

    mapDomainError(reply, new RateLimitedError(30));

    expect(captured.status).toBe(429);
    expect((captured.payload as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
    expect(captured.headers['Retry-After']).toBe('30');
  });

  it('maps unknown errors to 500 INTERNAL_ERROR', () => {
    const { reply, captured } = makeMockReply();

    mapDomainError(reply, new Error('unexpected'));

    expect(captured.status).toBe(500);
    expect((captured.payload as { error: { code: string } }).error.code).toBe('INTERNAL_ERROR');
  });

  it('maps non-Error unknown values to 500 INTERNAL_ERROR', () => {
    const { reply, captured } = makeMockReply();

    mapDomainError(reply, 'something went wrong');

    expect(captured.status).toBe(500);
    expect((captured.payload as { error: { code: string } }).error.code).toBe('INTERNAL_ERROR');
  });
});

// ---------------------------------------------------------------------------
// maskSecret
// ---------------------------------------------------------------------------

describe('maskSecret', () => {
  it('returns masked string with last 4 chars for strings longer than 4', () => {
    expect(maskSecret('my-api-key-xyz')).toBe('****-xyz');
  });

  it('returns **** for strings of exactly 4 characters', () => {
    expect(maskSecret('abcd')).toBe('****');
  });

  it('returns **** for strings shorter than 4 characters', () => {
    expect(maskSecret('abc')).toBe('****');
    expect(maskSecret('')).toBe('****');
  });

  it('handles long strings', () => {
    const longStr = 'abcdefgh1234567890abcdef';
    expect(maskSecret(longStr)).toBe('****cdef');
  });
});
