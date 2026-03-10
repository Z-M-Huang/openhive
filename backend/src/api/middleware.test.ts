/**
 * Tests for OpenHive Backend - Fastify Middleware Plugins
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

import {
  requestIdPlugin,
  securityHeadersPlugin,
  timingPlugin,
  structuredLoggingPlugin,
  corsPlugin,
  panicRecoveryPlugin,
  type DBLogger,
  type MiddlewareLogger,
} from './middleware.js';
import type { LogEntry } from '../domain/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): MiddlewareLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeDBLogger(): DBLogger & { entries: Omit<LogEntry, 'id'>[] } {
  const entries: Omit<LogEntry, 'id'>[] = [];
  return {
    entries,
    log(entry: Omit<LogEntry, 'id'>) {
      entries.push(entry);
    },
  };
}

// ---------------------------------------------------------------------------
// requestIdPlugin
// ---------------------------------------------------------------------------

describe('requestIdPlugin', () => {
  it('adds UUID X-Request-ID response header', async () => {
    const app = Fastify({ logger: false });
    await app.register(requestIdPlugin);
    app.get('/test', async (_req, reply) => {
      reply.send({ ok: true });
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/test' });
    const id = res.headers['x-request-id'];
    expect(typeof id).toBe('string');
    // UUID v4 format
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('each request gets a different UUID', async () => {
    const app = Fastify({ logger: false });
    await app.register(requestIdPlugin);
    app.get('/test', async (_req, reply) => {
      reply.send({ ok: true });
    });
    await app.ready();

    const r1 = await app.inject({ method: 'GET', url: '/test' });
    const r2 = await app.inject({ method: 'GET', url: '/test' });
    expect(r1.headers['x-request-id']).not.toBe(r2.headers['x-request-id']);
  });
});

// ---------------------------------------------------------------------------
// securityHeadersPlugin
// ---------------------------------------------------------------------------

describe('securityHeadersPlugin', () => {
  it('sets all required security headers', async () => {
    const app = Fastify({ logger: false });
    await app.register(securityHeadersPlugin);
    app.get('/test', async (_req, reply) => {
      reply.send({ ok: true });
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/test' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-xss-protection']).toBe('0');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain('ws:');
    expect(res.headers['content-security-policy']).toContain('wss:');
    expect(res.headers['content-security-policy']).toContain("'unsafe-inline'");
  });
});

// ---------------------------------------------------------------------------
// timingPlugin
// ---------------------------------------------------------------------------

describe('timingPlugin', () => {
  it('adds X-Response-Time header in ms format', async () => {
    const app = Fastify({ logger: false });
    await app.register(timingPlugin);
    app.get('/test', async (_req, reply) => {
      reply.send({ ok: true });
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/test' });
    const timing = res.headers['x-response-time'];
    expect(typeof timing).toBe('string');
    expect(timing).toMatch(/^\d+ms$/);
  });
});

// ---------------------------------------------------------------------------
// structuredLoggingPlugin
// ---------------------------------------------------------------------------

describe('structuredLoggingPlugin', () => {
  it('logs 2xx requests at info level', async () => {
    const logger = makeLogger();
    const app = Fastify({ logger: false });
    await app.register(timingPlugin); // needed for _startTime
    await app.register(requestIdPlugin); // needed for requestId
    await app.register(structuredLoggingPlugin(logger));
    app.get('/ok', async (_req, reply) => {
      reply.send({ ok: true });
    });
    await app.ready();

    await app.inject({ method: 'GET', url: '/ok' });
    expect(logger.info).toHaveBeenCalledOnce();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs 4xx requests at warn level', async () => {
    const logger = makeLogger();
    const app = Fastify({ logger: false });
    await app.register(requestIdPlugin);
    await app.register(structuredLoggingPlugin(logger));
    app.get('/not-found', async (_req, reply) => {
      reply.code(404).send({ error: 'not found' });
    });
    await app.ready();

    await app.inject({ method: 'GET', url: '/not-found' });
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs 5xx requests at error level', async () => {
    const logger = makeLogger();
    const app = Fastify({ logger: false });
    await app.register(requestIdPlugin);
    await app.register(structuredLoggingPlugin(logger));
    app.get('/fail', async (_req, reply) => {
      reply.code(500).send({ error: 'boom' });
    });
    await app.ready();

    await app.inject({ method: 'GET', url: '/fail' });
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('writes to dbLogger when provided', async () => {
    const logger = makeLogger();
    const db = makeDBLogger();
    const app = Fastify({ logger: false });
    await app.register(requestIdPlugin);
    await app.register(structuredLoggingPlugin(logger, db));
    app.get('/db-test', async (_req, reply) => {
      reply.send({ ok: true });
    });
    await app.ready();

    await app.inject({ method: 'GET', url: '/db-test' });
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0]?.level).toBe('info');
    expect(db.entries[0]?.component).toBe('api');
  });

  it('does not write to dbLogger when not provided', async () => {
    const logger = makeLogger();
    const db = makeDBLogger();
    const app = Fastify({ logger: false });
    await app.register(requestIdPlugin);
    await app.register(structuredLoggingPlugin(logger)); // no db
    app.get('/no-db', async (_req, reply) => {
      reply.send({ ok: true });
    });
    await app.ready();

    await app.inject({ method: 'GET', url: '/no-db' });
    expect(db.entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// corsPlugin
// ---------------------------------------------------------------------------

describe('corsPlugin', () => {
  it('sets CORS headers for allowed origins', async () => {
    const app = Fastify({ logger: false });
    await app.register(corsPlugin(['https://app.example.com']));
    app.get('/data', async (_req, reply) => {
      reply.send({ ok: true });
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/data',
      headers: { origin: 'https://app.example.com' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
    expect(res.headers['access-control-allow-methods']).toBeTruthy();
    expect(res.headers['vary']).toBe('Origin');
  });

  it('does not set CORS headers for disallowed origins', async () => {
    const app = Fastify({ logger: false });
    await app.register(corsPlugin(['https://app.example.com']));
    app.get('/data', async (_req, reply) => {
      reply.send({ ok: true });
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/data',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('handles OPTIONS preflight for allowed origins with 204', async () => {
    const app = Fastify({ logger: false });
    await app.register(corsPlugin(['https://app.example.com']));
    // No route registered — the onRequest hook intercepts OPTIONS before routing
    // and sends 204, terminating the lifecycle without a route handler.
    await app.ready();

    const res = await app.inject({
      method: 'OPTIONS',
      url: '/data',
      headers: { origin: 'https://app.example.com' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
  });

  it('does not short-circuit OPTIONS for disallowed origins', async () => {
    const app = Fastify({ logger: false });
    await app.register(corsPlugin(['https://app.example.com']));
    app.options('/data', async (_req, reply) => {
      reply.code(200).send({ handled: true });
    });
    await app.ready();

    const res = await app.inject({
      method: 'OPTIONS',
      url: '/data',
      headers: { origin: 'https://evil.example.com' },
    });
    // Should reach the route handler, not be intercepted by CORS
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// panicRecoveryPlugin
// ---------------------------------------------------------------------------

describe('panicRecoveryPlugin', () => {
  it('catches unhandled errors and returns 500 JSON', async () => {
    const logger = makeLogger();
    const app = Fastify({ logger: false });
    await app.register(requestIdPlugin);
    await app.register(panicRecoveryPlugin(logger));
    app.get('/crash', async () => {
      throw new Error('something exploded');
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/crash' });
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('an internal error occurred');
    expect(logger.error).toHaveBeenCalledOnce();
  });
});
