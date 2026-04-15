/**
 * Plugin tools API deprecated-before-remove enforcement (AC-29).
 *
 * Verifies:
 *   - /deprecate requires a non-blank reason (400 otherwise)
 *   - /deprecate calls store.deprecate() and persists reason + by
 *   - /remove rejects active tools with 409
 *   - /remove accepts deprecated tools, calls store.markRemoved()
 *   - Audit endpoint returns lifecycle fields (deprecatedAt, deprecatedReason,
 *     deprecatedBy, removedAt, removedBy)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { IPluginToolStore, PluginToolMeta } from '../domain/interfaces.js';
import { registerToolRoutes } from './tools.js';

class MemPluginToolStore implements IPluginToolStore {
  readonly rows = new Map<string, PluginToolMeta>();

  #key(t: string, n: string): string { return `${t}::${n}`; }

  upsert(meta: PluginToolMeta): void {
    this.rows.set(this.#key(meta.teamName, meta.toolName), { ...meta });
  }
  get(teamName: string, toolName: string): PluginToolMeta | undefined {
    return this.rows.get(this.#key(teamName, toolName));
  }
  getByTeam(teamName: string): PluginToolMeta[] {
    return [...this.rows.values()].filter(r => r.teamName === teamName);
  }
  getAll(): PluginToolMeta[] {
    return [...this.rows.values()];
  }
  setStatus(teamName: string, toolName: string, status: PluginToolMeta['status']): void {
    const row = this.get(teamName, toolName);
    if (row) this.rows.set(this.#key(teamName, toolName), { ...row, status });
  }
  deprecate(teamName: string, toolName: string, reason: string, by: string): void {
    const row = this.get(teamName, toolName);
    if (!row) return;
    this.rows.set(this.#key(teamName, toolName), {
      ...row,
      status: 'deprecated',
      deprecatedAt: new Date().toISOString(),
      deprecatedReason: reason,
      deprecatedBy: by,
    });
  }
  markRemoved(teamName: string, toolName: string, by: string): void {
    const row = this.get(teamName, toolName);
    if (!row) return;
    this.rows.set(this.#key(teamName, toolName), {
      ...row,
      status: 'removed',
      removedAt: new Date().toISOString(),
      removedBy: by,
    });
  }
  remove(teamName: string, toolName: string): void {
    this.rows.delete(this.#key(teamName, toolName));
  }
  removeByTeam(teamName: string): void {
    for (const k of [...this.rows.keys()]) {
      if (k.startsWith(`${teamName}::`)) this.rows.delete(k);
    }
  }
}

function seedActive(store: MemPluginToolStore, team: string, name: string): PluginToolMeta {
  const meta: PluginToolMeta = {
    teamName: team,
    toolName: name,
    status: 'active',
    sourcePath: `/tmp/nonexistent/teams/${team}/plugins/${name}.ts`,
    sourceHash: 'sha256:x',
    verification: { typescript: { valid: true, errors: [] } },
    verifiedAt: null,
    createdAt: '2026-04-14T00:00:00.000Z',
    updatedAt: '2026-04-14T00:00:00.000Z',
    deprecatedAt: null,
    deprecatedReason: null,
    deprecatedBy: null,
    removedAt: null,
    removedBy: null,
  };
  store.upsert(meta);
  return meta;
}

describe('Plugin tools API — deprecated-before-remove (AC-29)', () => {
  let fastify: FastifyInstance;
  let store: MemPluginToolStore;

  beforeAll(async () => {
    fastify = Fastify({ logger: false });
    store = new MemPluginToolStore();
    registerToolRoutes(fastify, store);
    await fastify.ready();
  });
  afterAll(async () => { await fastify.close(); });
  beforeEach(() => { store.rows.clear(); });

  // -- /deprecate reason validation ---------------------------------------

  it('POST /deprecate returns 400 when reason is missing', async () => {
    seedActive(store, 'alpha', 'demo');
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/v1/tools/alpha/demo/deprecate',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const tool = store.get('alpha', 'demo');
    expect(tool?.status).toBe('active');
  });

  it('POST /deprecate returns 400 when reason is blank', async () => {
    seedActive(store, 'alpha', 'demo');
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/v1/tools/alpha/demo/deprecate',
      payload: { reason: '   ' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /deprecate returns 404 when tool does not exist', async () => {
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/v1/tools/alpha/missing/deprecate',
      payload: { reason: 'test' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /deprecate persists reason + by and transitions status', async () => {
    seedActive(store, 'alpha', 'demo');
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/v1/tools/alpha/demo/deprecate',
      payload: { reason: 'replaced by demo_v2', by: 'planner@alpha' },
    });
    expect(res.statusCode).toBe(200);

    const tool = store.get('alpha', 'demo');
    expect(tool?.status).toBe('deprecated');
    expect(tool?.deprecatedReason).toBe('replaced by demo_v2');
    expect(tool?.deprecatedBy).toBe('planner@alpha');
    expect(tool?.deprecatedAt).toBeTruthy();
  });

  it('POST /deprecate defaults by to "unknown" when absent', async () => {
    seedActive(store, 'alpha', 'demo');
    await fastify.inject({
      method: 'POST',
      url: '/api/v1/tools/alpha/demo/deprecate',
      payload: { reason: 'retired' },
    });
    expect(store.get('alpha', 'demo')?.deprecatedBy).toBe('unknown');
  });

  // -- /remove enforcement -------------------------------------------------

  it('POST /remove returns 409 when tool is active (deprecated-before-remove)', async () => {
    seedActive(store, 'alpha', 'demo');
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/v1/tools/alpha/demo/remove',
      payload: { by: 'ops' },
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toMatch(/deprecated before/i);
    expect(store.get('alpha', 'demo')?.status).toBe('active');
  });

  it('POST /remove succeeds for deprecated tools and records removedAt/By', async () => {
    seedActive(store, 'alpha', 'demo');
    store.deprecate('alpha', 'demo', 'old', 'planner@alpha');

    const res = await fastify.inject({
      method: 'POST',
      url: '/api/v1/tools/alpha/demo/remove',
      payload: { by: 'ops@alpha' },
    });
    expect(res.statusCode).toBe(200);

    const tool = store.get('alpha', 'demo');
    expect(tool?.status).toBe('removed');
    expect(tool?.removedAt).toBeTruthy();
    expect(tool?.removedBy).toBe('ops@alpha');
    // deprecation history preserved
    expect(tool?.deprecatedReason).toBe('old');
  });

  it('POST /remove returns 409 for already-removed tools', async () => {
    seedActive(store, 'alpha', 'demo');
    store.deprecate('alpha', 'demo', 'old', 'p');
    store.markRemoved('alpha', 'demo', 'ops');

    const res = await fastify.inject({
      method: 'POST',
      url: '/api/v1/tools/alpha/demo/remove',
      payload: {},
    });
    expect(res.statusCode).toBe(409);
  });

  it('POST /remove returns 404 when tool does not exist', async () => {
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/v1/tools/alpha/missing/remove',
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  // -- audit endpoint exposes lifecycle fields ----------------------------

  it('GET /audit returns lifecycle fields for deprecated and removed tools', async () => {
    seedActive(store, 'alpha', 'keep');
    seedActive(store, 'alpha', 'gone');
    store.deprecate('alpha', 'keep', 'v2 exists', 'p');
    store.deprecate('alpha', 'gone', 'retired', 'p');
    store.markRemoved('alpha', 'gone', 'ops');

    const res = await fastify.inject({ method: 'GET', url: '/api/v1/tools/audit' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as PluginToolMeta[];
    const keep = body.find(t => t.toolName === 'keep');
    const gone = body.find(t => t.toolName === 'gone');
    expect(keep?.status).toBe('deprecated');
    expect(keep?.deprecatedReason).toBe('v2 exists');
    expect(gone?.status).toBe('removed');
    expect(gone?.removedBy).toBe('ops');
    expect(gone?.deprecatedReason).toBe('retired'); // history preserved
  });
});
