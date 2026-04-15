/**
 * Task stats grouping (AC-30).
 *
 * Verifies GET /api/v1/tasks/stats returns:
 *   - status: Record<string, number>
 *   - byType: Record<string, number>
 *   - byPriority: Record<string, number>
 *   - byTypeAndPriority: Array<{ type, priority, count }>
 * All rows are included (no filtering of failed/cancelled).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createDatabase, createTables } from '../storage/database.js';
import type { DatabaseInstance } from '../storage/database.js';
import { registerTasksRoutes } from './tasks.js';

interface StatsBody {
  status: Record<string, number>;
  byType: Record<string, number>;
  byPriority: Record<string, number>;
  byTypeAndPriority: Array<{ type: string; priority: string; count: number }>;
  includes: string;
}

function insertTask(
  raw: DatabaseInstance['raw'],
  id: string,
  team: string,
  type: string,
  priority: string,
  status: string,
): void {
  raw.prepare(
    `INSERT INTO task_queue (id, team_id, task, type, priority, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, team, 'x', type, priority, status, '2026-04-14T00:00:00Z');
}

describe('GET /api/v1/tasks/stats — grouping by type and priority (AC-30)', () => {
  let fastify: FastifyInstance;
  let instance: DatabaseInstance;

  beforeAll(async () => {
    instance = createDatabase(':memory:');
    createTables(instance.raw);

    insertTask(instance.raw, 't1', 'alpha', 'delegate', 'normal', 'pending');
    insertTask(instance.raw, 't2', 'alpha', 'delegate', 'high',   'pending');
    insertTask(instance.raw, 't3', 'alpha', 'trigger',  'normal', 'done');
    insertTask(instance.raw, 't4', 'beta',  'trigger',  'low',    'failed');
    insertTask(instance.raw, 't5', 'beta',  'delegate', 'normal', 'done');
    insertTask(instance.raw, 't6', 'beta',  'escalation', 'high', 'pending');

    fastify = Fastify({ logger: false });
    registerTasksRoutes(fastify, { raw: instance.raw });
    await fastify.ready();
  });
  afterAll(async () => {
    await fastify.close();
    instance.raw.close();
  });

  it('groups by status (backwards-compatible .data field preserved)', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/tasks/stats' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as StatsBody & { data: Record<string, number> };
    expect(body.status).toEqual({ pending: 3, done: 2, failed: 1 });
    // Legacy .data field still matches status
    expect(body.data).toEqual(body.status);
  });

  it('groups by type', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/tasks/stats' });
    const body = JSON.parse(res.body) as StatsBody;
    expect(body.byType).toEqual({ delegate: 3, trigger: 2, escalation: 1 });
  });

  it('groups by priority', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/tasks/stats' });
    const body = JSON.parse(res.body) as StatsBody;
    expect(body.byPriority).toEqual({ normal: 3, high: 2, low: 1 });
  });

  it('groups by type+priority as an array, sorted', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/tasks/stats' });
    const body = JSON.parse(res.body) as StatsBody;
    expect(body.byTypeAndPriority).toContainEqual({ type: 'delegate', priority: 'normal', count: 2 });
    expect(body.byTypeAndPriority).toContainEqual({ type: 'delegate', priority: 'high', count: 1 });
    expect(body.byTypeAndPriority).toContainEqual({ type: 'trigger', priority: 'normal', count: 1 });
    expect(body.byTypeAndPriority).toContainEqual({ type: 'trigger', priority: 'low', count: 1 });
    expect(body.byTypeAndPriority).toContainEqual({ type: 'escalation', priority: 'high', count: 1 });
    // Total should equal 6
    const total = body.byTypeAndPriority.reduce((s, r) => s + r.count, 0);
    expect(total).toBe(6);
  });

  it('declares includes=all-rows (failed/cancelled not filtered out)', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/tasks/stats' });
    const body = JSON.parse(res.body) as StatsBody;
    expect(body.includes).toBe('all-rows');
    expect(body.status.failed).toBe(1);
  });

  it('composite index exists after migration', () => {
    const idx = instance.raw.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_task_queue_type_priority_status'",
    ).get() as { name: string } | undefined;
    expect(idx?.name).toBe('idx_task_queue_type_priority_status');
  });
});
