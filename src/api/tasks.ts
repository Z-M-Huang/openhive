/**
 * GET /api/v1/tasks       — paginated task list with optional filters.
 * GET /api/v1/tasks/stats — aggregate task counts by status.
 * GET /api/v1/tasks/:id   — single task detail.
 */

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { errorMessage } from '../domain/errors.js';

export interface TasksDeps {
  readonly raw: Database.Database;
}

interface TaskRow {
  readonly id: string;
  readonly team_id: string;
  readonly task: string;
  readonly priority: string;
  readonly type: string;
  readonly status: string;
  readonly created_at: string;
  readonly correlation_id: string | null;
  readonly result: string | null;
  readonly duration_ms: number | null;
  readonly source_channel_id: string | null;
  readonly topic_id: string | null;
}

interface TaskStatsRow {
  readonly status: string;
  readonly count: number;
}

function clampLimit(raw: unknown): number {
  const n = Number(raw) || 50;
  return Math.max(1, Math.min(n, 100));
}

function clampOffset(raw: unknown): number {
  const n = Number(raw) || 0;
  return Math.max(0, n);
}

function mapTaskRow(row: TaskRow) {
  return {
    id: row.id,
    teamId: row.team_id,
    task: row.task,
    priority: row.priority,
    type: row.type,
    status: row.status,
    createdAt: row.created_at,
    correlationId: row.correlation_id,
    result: row.result,
    durationMs: row.duration_ms,
    sourceChannelId: row.source_channel_id,
    topicId: row.topic_id,
  };
}

function buildWhereClause(filters: Record<string, string | undefined>): { where: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const columnMap: Record<string, string> = { status: 'status', team: 'team_id', type: 'type', priority: 'priority' };
  for (const [key, value] of Object.entries(filters)) {
    if (value && columnMap[key]) {
      conditions.push(`${columnMap[key]} = ?`);
      params.push(value);
    }
  }
  return { where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

export function registerTasksRoutes(fastify: FastifyInstance, deps: TasksDeps): void {
  // GET /api/v1/tasks/stats — MUST be registered before :id param route
  fastify.get('/api/v1/tasks/stats', async (_request, reply) => {
    try {
      const rows = deps.raw.prepare(
        'SELECT status, COUNT(*) AS count FROM task_queue GROUP BY status',
      ).all() as TaskStatsRow[];
      const stats: Record<string, number> = {};
      for (const row of rows) { stats[row.status] = row.count; }
      await reply.code(200).send({ data: stats });
    } catch (err) {
      await reply.code(500).send({ error: errorMessage(err) });
    }
  });

  // GET /api/v1/tasks/:id — single task detail
  fastify.get<{ Params: { id: string } }>('/api/v1/tasks/:id', async (request, reply) => {
    try {
      const row = deps.raw.prepare(
        'SELECT * FROM task_queue WHERE id = ?',
      ).get(request.params.id) as TaskRow | undefined;
      if (!row) { await reply.code(404).send({ error: `Task '${request.params.id}' not found` }); return; }
      await reply.code(200).send({ data: mapTaskRow(row) });
    } catch (err) {
      await reply.code(500).send({ error: errorMessage(err) });
    }
  });

  // GET /api/v1/tasks — paginated, filterable
  fastify.get<{
    Querystring: { limit?: string; offset?: string; status?: string; team?: string; type?: string; priority?: string };
  }>('/api/v1/tasks', async (request, reply) => {
    try {
      const limit = clampLimit(request.query.limit);
      const offset = clampOffset(request.query.offset);
      const { status, team, type, priority } = request.query;
      const { where, params } = buildWhereClause({ status, team, type, priority });

      const countRow = deps.raw.prepare(
        `SELECT COUNT(*) AS total FROM task_queue ${where}`,
      ).get(...params) as { total: number };
      const rows = deps.raw.prepare(
        `SELECT * FROM task_queue ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ).all(...params, limit, offset) as TaskRow[];

      await reply.code(200).send({ data: rows.map(mapTaskRow), total: countRow.total });
    } catch (err) {
      await reply.code(500).send({ error: errorMessage(err) });
    }
  });
}
