import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerOverviewRoute, type OverviewDeps } from './overview.js';
import type { ITaskQueueStore, ITriggerConfigStore } from '../domain/interfaces.js';
import { TaskStatus } from '../domain/types.js';
import type { TaskEntry, TriggerConfig } from '../domain/types.js';

interface OverviewResponse {
  data: {
    uptime: number;
    sqlite_size: number;
    team_count: number;
    queue_depth: number;
    trigger_stats: { total: number; active: number; disabled: number };
  };
}

interface ErrorResponse {
  error: string;
}

function mockTaskQueueStore(pending: TaskEntry[] = []): ITaskQueueStore {
  return {
    enqueue: () => 'task-1',
    dequeue: () => undefined,
    peek: () => undefined,
    getByTeam: () => [],
    updateStatus: () => {},
    updateResult: () => {},
    getPending: () => pending,
    getByStatus: () => [],
    removeByTeam: () => {},
    getById: () => undefined,
  };
}

function mockTriggerConfigStore(triggers: TriggerConfig[] = []): ITriggerConfigStore {
  return {
    upsert: () => {},
    remove: () => {},
    removeByTeam: () => {},
    getByTeam: () => [],
    getAll: () => triggers,
    setState: () => {},
    incrementFailures: () => 0,
    resetFailures: () => {},
    get: () => undefined,
    setActiveTask: () => {},
    clearActiveTask: () => {},
    setOverlapCount: () => {},
    resetOverlapState: () => {},
  };
}

function mockRawDb() {
  return {
    prepare: (sql: string) => ({
      get: () => {
        if (sql.includes('page_count')) return { size: 4096 };
        if (sql.includes('COUNT')) return { cnt: 3 };
        return undefined;
      },
    }),
  };
}

describe('GET /api/v1/overview', () => {
  let fastify: FastifyInstance;

  const triggers: TriggerConfig[] = [
    { team: 'main', name: 'sched-1', type: 'schedule', config: {}, task: 'run', state: 'active' },
    { team: 'main', name: 'sched-2', type: 'schedule', config: {}, task: 'run', state: 'disabled' },
    { team: 'sub', name: 'kw-1', type: 'keyword', config: {}, task: 'do', state: 'active' },
  ];

  const pendingTasks: TaskEntry[] = [
    { id: 't1', teamId: 'main', task: 'work', priority: 'normal', type: 'delegate', status: TaskStatus.Pending, createdAt: new Date().toISOString(), correlationId: null, result: null, durationMs: null, options: null, sourceChannelId: null, topicId: null },
    { id: 't2', teamId: 'sub', task: 'work2', priority: 'high', type: 'trigger', status: TaskStatus.Pending, createdAt: new Date().toISOString(), correlationId: null, result: null, durationMs: null, options: null, sourceChannelId: null, topicId: null },
  ];

  beforeAll(async () => {
    fastify = Fastify({ logger: false });
    const deps: OverviewDeps = {
      raw: mockRawDb() as unknown as OverviewDeps['raw'],
      orgTree: {} as OverviewDeps['orgTree'], // not directly used — team count from raw SQL
      taskQueueStore: mockTaskQueueStore(pendingTasks),
      triggerConfigStore: mockTriggerConfigStore(triggers),
    };
    registerOverviewRoute(fastify, deps);
    await fastify.ready();
  }, 30_000);

  afterAll(async () => {
    await fastify.close();
  });

  it('returns 200 with expected envelope shape', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/overview' });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as OverviewResponse;
    expect(body).toHaveProperty('data');
    expect(body.data).toHaveProperty('uptime');
    expect(body.data).toHaveProperty('sqlite_size');
    expect(body.data).toHaveProperty('team_count');
    expect(body.data).toHaveProperty('queue_depth');
    expect(body.data).toHaveProperty('trigger_stats');
  });

  it('returns correct team count from raw SQL', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/overview' });
    const body = JSON.parse(res.body) as OverviewResponse;
    expect(body.data.team_count).toBe(3);
  });

  it('returns correct queue depth from pending tasks', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/overview' });
    const body = JSON.parse(res.body) as OverviewResponse;
    expect(body.data.queue_depth).toBe(2);
  });

  it('returns correct trigger stats', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/overview' });
    const body = JSON.parse(res.body) as OverviewResponse;
    expect(body.data.trigger_stats).toEqual({
      total: 3,
      active: 2,
      disabled: 1,
    });
  });

  it('returns sqlite size from pragma', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/overview' });
    const body = JSON.parse(res.body) as OverviewResponse;
    expect(body.data.sqlite_size).toBe(4096);
  });

  it('returns uptime as a positive number', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/overview' });
    const body = JSON.parse(res.body) as OverviewResponse;
    expect(typeof body.data.uptime).toBe('number');
    expect(body.data.uptime).toBeGreaterThanOrEqual(0);
  });

  it('returns 500 on internal error', async () => {
    const brokenFastify = Fastify({ logger: false });
    const brokenDeps: OverviewDeps = {
      raw: { prepare: () => { throw new Error('db gone'); } } as unknown as OverviewDeps['raw'],
      orgTree: {} as OverviewDeps['orgTree'],
      taskQueueStore: { getPending: () => { throw new Error('store gone'); } } as unknown as ITaskQueueStore,
      triggerConfigStore: mockTriggerConfigStore(),
    };
    registerOverviewRoute(brokenFastify, brokenDeps);
    await brokenFastify.ready();

    const res = await brokenFastify.inject({ method: 'GET', url: '/api/v1/overview' });
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body) as ErrorResponse;
    expect(body).toHaveProperty('error');

    await brokenFastify.close();
  });
});
