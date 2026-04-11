/**
 * Health endpoint tests (migrated from layer-9.test.ts)
 *
 * UT-25: Health endpoint returns 200 with component status
 * Health endpoint returns 503 when storage fails
 */

import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';

import { registerHealthEndpoint } from './health.js';
import { TeamRegistry } from './sessions/team-registry.js';
import { TriggerEngine } from './triggers/engine.js';
import { TriggerDedup } from './triggers/dedup.js';
import { TriggerRateLimiter } from './triggers/rate-limiter.js';
import { ChannelRouter } from './channels/router.js';
import { createDatabase, createTables } from './storage/database.js';

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
    delegateTask: async () => { return ''; },
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
    const sessionManager = new TeamRegistry();
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
    const sessionManager = new TeamRegistry();
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
    const sessionManager = new TeamRegistry();
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
