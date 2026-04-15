/**
 * Triggers API tests — subagent column exposure (AC-7).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerTriggersRoutes, type TriggersDeps } from './triggers.js';

interface TriggerResponse {
  data: {
    id: number;
    team: string;
    name: string;
    type: string;
    config: string;
    task: string;
    skill: string | null;
    subagent: string | null;
    state: string;
    maxSteps: number;
    failureThreshold: number;
    consecutiveFailures: number;
    disabledReason: string | null;
    sourceChannelId: string | null;
    createdAt: string;
    updatedAt: string;
  };
}

interface TriggerListResponse {
  data: Array<TriggerResponse['data']>;
  total: number;
}

interface ErrorResponse {
  error: string;
}

const NOW = '2026-04-07T00:00:00Z';

const ROWS = [
  {
    id: 1,
    team: 'main',
    name: 'daily-report',
    type: 'schedule',
    config: '{"cron":"0 9 * * *"}',
    task: 'Generate daily report',
    skill: null,
    subagent: 'reporter',
    state: 'active',
    max_steps: 100,
    failure_threshold: 3,
    consecutive_failures: 0,
    disabled_reason: null,
    source_channel_id: null,
    created_at: NOW,
    updated_at: NOW,
  },
  {
    id: 2,
    team: 'main',
    name: 'keyword-alert',
    type: 'keyword',
    config: '{"pattern":"urgent"}',
    task: 'Handle urgent keywords',
    skill: 'alerting',
    subagent: null,
    state: 'pending',
    max_steps: 50,
    failure_threshold: 3,
    consecutive_failures: 0,
    disabled_reason: null,
    source_channel_id: 'channel-123',
    created_at: NOW,
    updated_at: NOW,
  },
  {
    id: 3,
    team: 'ops',
    name: 'monitoring-check',
    type: 'schedule',
    config: '{"cron":"*/5 * * * *"}',
    task: 'Check monitoring',
    skill: null,
    subagent: 'monitor',
    state: 'disabled',
    max_steps: 100,
    failure_threshold: 3,
    consecutive_failures: 5,
    disabled_reason: 'Too many failures',
    source_channel_id: null,
    created_at: NOW,
    updated_at: NOW,
  },
];

function mockRawDb(rows = ROWS) {
  return {
    prepare: (_sql: string) => {
      const sql = _sql;
      return {
        get: (...params: unknown[]) => {
          // Handle single row lookup by ID
          if (sql.includes('WHERE id = ?')) {
            const id = Number(params[0]);
            return rows.find(r => r.id === id);
          }
          // Handle COUNT queries
          if (sql.includes('COUNT')) {
            const filtered = applyFilter(sql, params, rows);
            return { total: filtered.length };
          }
          // Other single row lookups
          const filtered = applyFilter(sql, params, rows);
          return filtered[0];
        },
        all: (...params: unknown[]) => {
          return applyFilter(sql, params, rows);
        },
      };
    },
  };
}

function applyFilter(sql: string, params: unknown[], rows: typeof ROWS) {
  let result = [...rows];
  let paramIdx = 0;

  // Parse and apply each condition - order matters based on SQL WHERE clause order
  if (sql.includes('team = ?')) {
    const teamParam = params[paramIdx];
    if (typeof teamParam === 'string') {
      result = result.filter(r => r.team === teamParam);
      paramIdx++;
    }
  }
  if (sql.includes('state = ?')) {
    const stateParam = params[paramIdx];
    if (typeof stateParam === 'string') {
      result = result.filter(r => r.state === stateParam);
      paramIdx++;
    }
  }
  if (sql.includes('name = ?')) {
    const nameParam = params[paramIdx];
    if (typeof nameParam === 'string') {
      result = result.filter(r => r.name === nameParam);
      paramIdx++;
    }
  }
  if (sql.includes('subagent = ?')) {
    const subagentParam = params[paramIdx];
    if (typeof subagentParam === 'string') {
      result = result.filter(r => r.subagent === subagentParam);
      paramIdx++;
    }
  }

  // Handle pagination params (limit, offset) - they're at the end
  // For simplicity, we ignore them in the mock filter

  return result;
}

describe('GET /api/v1/triggers — subagent exposure', () => {
  let fastify: FastifyInstance;

  beforeAll(async () => {
    fastify = Fastify({ logger: false });
    registerTriggersRoutes(fastify, {
      raw: mockRawDb() as unknown as TriggersDeps['raw'],
      triggerConfigStore: {
        setState: () => {},
      } as unknown as TriggersDeps['triggerConfigStore'],
    });
    await fastify.ready();
  }, 30_000);

  afterAll(async () => {
    await fastify.close();
  });

  it('returns triggers with subagent field', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/triggers' });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as TriggerListResponse;
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('total');
    expect(body.data.length).toBe(3);
    expect(body.total).toBe(3);
  });

  it('includes subagent value when present', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/triggers' });
    const body = JSON.parse(res.body) as TriggerListResponse;

    const dailyReport = body.data.find(t => t.name === 'daily-report')!;
    expect(dailyReport.subagent).toBe('reporter');
  });

  it('returns null for subagent when not set', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/triggers' });
    const body = JSON.parse(res.body) as TriggerListResponse;

    const keywordAlert = body.data.find(t => t.name === 'keyword-alert')!;
    expect(keywordAlert.subagent).toBeNull();
  });

  it('filters by subagent query parameter', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/triggers?subagent=reporter' });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as TriggerListResponse;
    expect(body.data.length).toBe(1);
    expect(body.data[0].name).toBe('daily-report');
    expect(body.data[0].subagent).toBe('reporter');
  });
});

describe('GET /api/v1/triggers/:id — subagent exposure', () => {
  let fastify: FastifyInstance;

  beforeAll(async () => {
    fastify = Fastify({ logger: false });
    registerTriggersRoutes(fastify, {
      raw: mockRawDb() as unknown as TriggersDeps['raw'],
      triggerConfigStore: {
        setState: () => {},
      } as unknown as TriggersDeps['triggerConfigStore'],
    });
    await fastify.ready();
  }, 30_000);

  afterAll(async () => {
    await fastify.close();
  });

  it('returns single trigger with subagent field', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/triggers/1' });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as TriggerResponse;
    expect(body.data.subagent).toBe('reporter');
  });

  it('returns null subagent when not set', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/triggers/2' });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as TriggerResponse;
    expect(body.data.subagent).toBeNull();
  });

  it('returns 404 for non-existent trigger', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/triggers/999' });
    expect(res.statusCode).toBe(404);

    const body = JSON.parse(res.body) as ErrorResponse;
    expect(body).toHaveProperty('error');
  });
});