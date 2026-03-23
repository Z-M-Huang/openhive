/**
 * Layer 9 Phase Gate -- Bootstrap + Health Endpoint
 *
 * Tests:
 * - UT-25: Health endpoint returns 200 with component status
 * - Health endpoint returns 503 when storage fails
 * - Bootstrap creates all components
 * - Graceful shutdown stops all components
 */

import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import Fastify from 'fastify';

import { registerHealthEndpoint } from '../health.js';
import { SessionManager } from '../sessions/manager.js';
import { TriggerEngine } from '../triggers/engine.js';
import { TriggerDedup } from '../triggers/dedup.js';
import { TriggerRateLimiter } from '../triggers/rate-limiter.js';
import { ChannelRouter } from '../channels/router.js';
import { createDatabase, createTables } from '../storage/database.js';
import { bootstrap } from '../index.js';
import type { BootstrapResult } from '../index.js';

// ── Types ─────────────────────────────────────────────────────────────────

interface HealthResponse {
  storage: { ok: boolean };
  sessions: { active: number };
  triggers: { registered: number };
  channels: { connected: number };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function createTempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'openhive-l9-'));
  const dbPath = join(dir, 'test.db');
  const { raw } = createDatabase(dbPath);
  createTables(raw);
  return { raw, dbPath };
}

function createMinimalTriggerEngine(): TriggerEngine {
  const triggerStore = {
    checkDedup: () => false,
    recordEvent: () => {},
    cleanExpired: () => 0,
  };
  const dedup = new TriggerDedup(triggerStore);
  const rateLimiter = new TriggerRateLimiter(10, 60_000);
  return new TriggerEngine({
    triggers: [],
    dedup,
    rateLimiter,
    delegateTask: async () => {},
    logger: { info: () => {}, warn: () => {} },
  });
}

function parseHealth(body: string): HealthResponse {
  return JSON.parse(body) as HealthResponse;
}

// ── UT-25: Health Endpoint returns 200 ───────────────────────────────────

describe('UT-25: Health endpoint returns 200 with component status', () => {
  it('returns 200 with all component statuses when storage is healthy', { timeout: 15_000 }, async () => {
    const { raw } = createTempDb();
    const sessionManager = new SessionManager();
    const triggerEngine = createMinimalTriggerEngine();
    triggerEngine.register();
    const channelRouter = new ChannelRouter([], async () => undefined);

    const fastify = Fastify({ logger: false });
    registerHealthEndpoint(fastify, { raw, sessionManager, triggerEngine, channelRouter });

    const response = await fastify.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    const body = parseHealth(response.body);
    expect(body.storage.ok).toBe(true);
    expect(body.sessions.active).toBe(0);
    expect(body.triggers.registered).toBe(0);
    expect(body.channels.connected).toBe(0);

    raw.close();
    await fastify.close();
  });

  it('reflects active sessions in health response', async () => {
    const { raw } = createTempDb();
    const sessionManager = new SessionManager();
    sessionManager.spawn('team-alpha');
    sessionManager.spawn('team-beta');

    const triggerEngine = createMinimalTriggerEngine();
    const channelRouter = new ChannelRouter([], async () => undefined);

    const fastify = Fastify({ logger: false });
    registerHealthEndpoint(fastify, { raw, sessionManager, triggerEngine, channelRouter });

    const response = await fastify.inject({ method: 'GET', url: '/health' });
    const body = parseHealth(response.body);
    expect(body.sessions.active).toBe(2);

    sessionManager.stopAll();
    raw.close();
    await fastify.close();
  });
});

// ── Health endpoint returns 503 when storage fails ──────────────────────

describe('Health endpoint returns 503 when storage fails', () => {
  it('returns 503 when database is closed', async () => {
    const { raw } = createTempDb();
    const sessionManager = new SessionManager();
    const triggerEngine = createMinimalTriggerEngine();
    const channelRouter = new ChannelRouter([], async () => undefined);

    const fastify = Fastify({ logger: false });
    registerHealthEndpoint(fastify, { raw, sessionManager, triggerEngine, channelRouter });

    // Close the database to simulate failure
    raw.close();

    const response = await fastify.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(503);
    const body = parseHealth(response.body);
    expect(body.storage.ok).toBe(false);

    await fastify.close();
  });
});

// ── Bootstrap creates all components ────────────────────────────────────

describe('Bootstrap creates all components', () => {
  let result: BootstrapResult | null = null;

  afterEach(async () => {
    if (result) {
      await result.shutdown();
      result = null;
    }
  });

  it('creates logger, db, session manager, trigger engine, channel router, fastify', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openhive-bootstrap-'));
    const input = new PassThrough();
    const output = new PassThrough();

    result = await bootstrap({
      runDir: dir,
      dataDir: join(dir, 'data'),
      skipListen: true,
      skipCli: true,
      cliInput: input,
      cliOutput: output,
    });

    expect(result.logger).toBeDefined();
    expect(result.raw).toBeDefined();
    expect(result.fastify).toBeDefined();
    expect(result.sessionManager).toBeDefined();
    expect(result.triggerEngine).toBeDefined();
    expect(result.channelRouter).toBeDefined();
    expect(result.orgTree).toBeDefined();

    // Verify health endpoint works through bootstrap
    const response = await result.fastify.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);

    input.end();
  });
});

// ── Graceful shutdown stops all components ──────────────────────────────

describe('Graceful shutdown stops all components', () => {
  it('shutdown closes database and all subsystems', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openhive-shutdown-'));

    const result = await bootstrap({
      runDir: dir,
      dataDir: join(dir, 'data'),
      skipListen: true,
      skipCli: true,
    });

    // Spawn a session so we can verify stopAll is called
    result.sessionManager.spawn('test-team');
    expect(result.sessionManager.getActive()).toHaveLength(1);

    await result.shutdown();

    // After shutdown, database should be closed
    expect(() => result.raw.prepare('SELECT 1').get()).toThrow();

    // Sessions should be stopped
    expect(result.sessionManager.getActive()).toHaveLength(0);
  });
});
