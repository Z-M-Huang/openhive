import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerVaultRoutes, type VaultDeps } from './vault.js';

interface VaultResponse {
  data: Array<{
    id: number;
    teamName: string;
    key: string;
    value: string;
    isSecret: boolean;
    updatedBy: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  total: number;
}

interface ErrorResponse {
  error: string;
}

const NOW = '2026-04-07T00:00:00Z';

const ROWS = [
  { id: 1, team_name: 'main', key: 'API_KEY', value: 'sk-secret-123', is_secret: 1, updated_by: 'admin', created_at: NOW, updated_at: NOW },
  { id: 2, team_name: 'main', key: 'MODEL', value: 'gpt-4', is_secret: 0, updated_by: null, created_at: NOW, updated_at: NOW },
  { id: 3, team_name: 'sub', key: 'TOKEN', value: 'tok-abc', is_secret: 1, updated_by: 'admin', created_at: NOW, updated_at: NOW },
];

function mockRawDb(rows = ROWS) {
  return {
    prepare: (sql: string) => ({
      get: (..._params: unknown[]) => {
        const filtered = applyFilter(sql, _params, rows);
        if (sql.includes('COUNT')) return { total: filtered.length };
        return undefined;
      },
      all: (..._params: unknown[]) => {
        return applyFilter(sql, _params, rows);
      },
    }),
  };
}

function applyFilter(sql: string, params: unknown[], rows: typeof ROWS) {
  let result = [...rows];
  if (sql.includes('team_name = ?')) {
    const teamIdx = 0;
    result = result.filter(r => r.team_name === params[teamIdx]);
  }
  return result;
}

describe('GET /api/v1/vault', () => {
  let fastify: FastifyInstance;

  beforeAll(async () => {
    fastify = Fastify({ logger: false });
    registerVaultRoutes(fastify, { raw: mockRawDb() as unknown as VaultDeps['raw'] });
    await fastify.ready();
  }, 30_000);

  afterAll(async () => {
    await fastify.close();
  });

  it('returns 200 with paginated vault entries', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/vault' });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as VaultResponse;
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('total');
    expect(body.data.length).toBe(3);
    expect(body.total).toBe(3);
  });

  it('omits value key for secret entries (is_secret=1)', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/vault' });
    const body = JSON.parse(res.body) as VaultResponse;

    const secretEntry = body.data.find(e => e.key === 'API_KEY')!;
    expect(secretEntry.value).toBeUndefined();
    expect(secretEntry.isSecret).toBe(true);

    const tokenEntry = body.data.find(e => e.key === 'TOKEN')!;
    expect(tokenEntry.value).toBeUndefined();
    expect(tokenEntry.isSecret).toBe(true);
  });

  it('returns plain value for non-secret entries', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/vault' });
    const body = JSON.parse(res.body) as VaultResponse;

    const nonSecretEntry = body.data.find(e => e.key === 'MODEL')!;
    expect(nonSecretEntry.value).toBe('gpt-4');
    expect(nonSecretEntry.isSecret).toBe(false);
  });

  it('filters by ?team=X', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/vault?team=sub' });
    const body = JSON.parse(res.body) as VaultResponse;

    expect(body.data.length).toBe(1);
    expect(body.data[0].teamName).toBe('sub');
    expect(body.data[0].key).toBe('TOKEN');
  });

  it('returns 500 on internal error', async () => {
    const brokenFastify = Fastify({ logger: false });
    const brokenDeps: VaultDeps = {
      raw: { prepare: () => { throw new Error('db gone'); } } as unknown as VaultDeps['raw'],
    };
    registerVaultRoutes(brokenFastify, brokenDeps);
    await brokenFastify.ready();

    const res = await brokenFastify.inject({ method: 'GET', url: '/api/v1/vault' });
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body) as ErrorResponse;
    expect(body).toHaveProperty('error');

    await brokenFastify.close();
  });
});
