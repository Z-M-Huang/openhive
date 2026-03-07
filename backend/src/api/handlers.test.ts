/**
 * Tests for OpenHive Backend - Core API Handlers
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

import { healthHandler, unlockHandler, notFoundHandler, type DroppedLogCounter } from './handlers.js';
import type { KeyManager } from '../domain/interfaces.js';
import {
  NotFoundError,
  ValidationError,
  EncryptionLockedError,
} from '../domain/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeKM(opts?: {
  unlockErr?: Error | null;
}): KeyManager {
  return {
    unlock: vi.fn().mockResolvedValue(undefined),
    ...((opts?.unlockErr != null)
      ? { unlock: vi.fn().mockRejectedValue(opts.unlockErr) }
      : {}),
    lock: vi.fn().mockResolvedValue(undefined),
    rekey: vi.fn().mockResolvedValue(undefined),
    encrypt: vi.fn().mockResolvedValue(''),
    decrypt: vi.fn().mockResolvedValue(new Uint8Array()),
    isUnlocked: vi.fn().mockReturnValue(true),
  } as unknown as KeyManager;
}

function makeCounter(count: number): DroppedLogCounter {
  return { droppedCount: () => count };
}

// ---------------------------------------------------------------------------
// healthHandler
// ---------------------------------------------------------------------------

describe('healthHandler', () => {
  it('returns ok status with uptime', async () => {
    const startTime = new Date(Date.now() - 5000); // 5 seconds ago
    const app = Fastify({ logger: false });
    app.get('/health', healthHandler(startTime));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: { status: string; version: string; uptime: string } };
    expect(body.data.status).toBe('ok');
    expect(body.data.version).toBe('0.1.0');
    expect(typeof body.data.uptime).toBe('string');
    expect(body.data.uptime.length).toBeGreaterThan(0);
  });

  it('includes dropped_log_entries when dbLogger provided', async () => {
    const startTime = new Date(Date.now() - 2000);
    const counter = makeCounter(42);
    const app = Fastify({ logger: false });
    app.get('/health', healthHandler(startTime, counter));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: { dropped_log_entries: number } };
    expect(body.data.dropped_log_entries).toBe(42);
  });

  it('omits dropped_log_entries when no dbLogger', async () => {
    const app = Fastify({ logger: false });
    app.get('/health', healthHandler(new Date()));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = JSON.parse(res.body) as { data: Record<string, unknown> };
    expect('dropped_log_entries' in body.data).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// unlockHandler
// ---------------------------------------------------------------------------

describe('unlockHandler', () => {
  it('unlocks key manager with valid key', async () => {
    const km = makeKM();
    const app = Fastify({ logger: false });
    app.post('/unlock', unlockHandler(km));
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/unlock',
      payload: { master_key: 'correct-key' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: { status: string } };
    expect(body.data.status).toBe('unlocked');
    expect(km.unlock).toHaveBeenCalledWith('correct-key');
  });

  it('rejects empty master_key', async () => {
    const km = makeKM();
    const app = Fastify({ logger: false });
    app.post('/unlock', unlockHandler(km));
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/unlock',
      payload: { master_key: '' },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(km.unlock).not.toHaveBeenCalled();
  });

  it('rejects missing master_key', async () => {
    const km = makeKM();
    const app = Fastify({ logger: false });
    app.post('/unlock', unlockHandler(km));
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/unlock',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('maps domain errors from key manager', async () => {
    const km = makeKM({ unlockErr: new EncryptionLockedError() });
    const app = Fastify({ logger: false });
    app.post('/unlock', unlockHandler(km));
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/unlock',
      payload: { master_key: 'some-key' },
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('ENCRYPTION_LOCKED');
  });
});

// ---------------------------------------------------------------------------
// notFoundHandler
// ---------------------------------------------------------------------------

describe('notFoundHandler', () => {
  it('returns 404 JSON error', async () => {
    const app = Fastify({ logger: false });
    app.setNotFoundHandler(notFoundHandler());
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/no-such-route' });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBe('the requested resource was not found');
  });
});
