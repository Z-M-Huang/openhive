/**
 * GET /api/v1/logs — paginated log entries with filters.
 *
 * Query params: limit, offset, level, since (ISO timestamp), search (message substring).
 */

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { errorMessage } from '../domain/errors.js';

export interface LogsDeps {
  readonly raw: Database.Database;
}

interface LogRow {
  readonly id: number;
  readonly level: string;
  readonly message: string;
  readonly context: string | null;
  readonly duration_ms: number | null;
  readonly created_at: string;
}

function clampLimit(raw: unknown): number {
  const n = Number(raw) || 50;
  return Math.max(1, Math.min(n, 100));
}

function clampOffset(raw: unknown): number {
  const n = Number(raw) || 0;
  return Math.max(0, n);
}

export function registerLogsRoutes(fastify: FastifyInstance, deps: LogsDeps): void {
  fastify.get<{
    Querystring: { limit?: string; offset?: string; level?: string; since?: string; search?: string };
  }>('/api/v1/logs', async (request, reply) => {
    try {
      const limit = clampLimit(request.query.limit);
      const offset = clampOffset(request.query.offset);
      const { level, since, search } = request.query;

      const conditions: string[] = [];
      const params: unknown[] = [];

      if (level) {
        conditions.push('level = ?');
        params.push(level);
      }
      if (since) {
        conditions.push('created_at >= ?');
        params.push(since);
      }
      if (search) {
        conditions.push('message LIKE ?');
        params.push(`%${search}%`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const countRow = deps.raw.prepare(
        `SELECT COUNT(*) AS total FROM log_entries ${whereClause}`,
      ).get(...params) as { total: number };

      const rows = deps.raw.prepare(
        `SELECT * FROM log_entries ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ).all(...params, limit, offset) as LogRow[];

      const data = rows.map((row) => ({
        id: row.id,
        level: row.level,
        message: row.message,
        context: row.context,
        durationMs: row.duration_ms,
        createdAt: row.created_at,
      }));

      await reply.code(200).send({ data, total: countRow.total });
    } catch (err) {
      await reply.code(500).send({ error: errorMessage(err) });
    }
  });
}
