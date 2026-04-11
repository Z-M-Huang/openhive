/**
 * GET /api/v1/memories     — paginated memory list with optional filters.
 * GET /api/v1/memories/:id — single memory detail.
 */

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { errorMessage } from '../domain/errors.js';

export interface MemoriesDeps {
  readonly raw: Database.Database;
}

interface MemoryRow {
  readonly id: number;
  readonly team_name: string;
  readonly key: string;
  readonly content: string;
  readonly type: string;
  readonly is_active: number;
  readonly supersedes_id: number | null;
  readonly supersede_reason: string | null;
  readonly updated_by: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

function clampLimit(raw: unknown): number {
  const n = Number(raw) || 50;
  return Math.max(1, Math.min(n, 100));
}

function clampOffset(raw: unknown): number {
  const n = Number(raw) || 0;
  return Math.max(0, n);
}

function mapMemoryRow(row: MemoryRow) {
  return {
    id: row.id,
    teamName: row.team_name,
    key: row.key,
    content: row.content,
    type: row.type,
    isActive: row.is_active === 1,
    supersedesId: row.supersedes_id,
    supersedeReason: row.supersede_reason,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function registerMemoriesRoutes(fastify: FastifyInstance, deps: MemoriesDeps): void {
  // GET /api/v1/memories/:id/chain — supersede chain for a memory
  fastify.get<{ Params: { id: string } }>('/api/v1/memories/:id/chain', async (request, reply) => {
    try {
      const chain: ReturnType<typeof mapMemoryRow>[] = [];
      let currentId: string | number | null = request.params.id;
      const visited = new Set<string | number>();
      while (currentId !== null) {
        if (visited.has(currentId)) break; // cycle guard
        visited.add(currentId);
        const row = deps.raw.prepare('SELECT * FROM memories WHERE id = ?').get(currentId) as MemoryRow | undefined;
        if (!row) break;
        chain.push(mapMemoryRow(row));
        currentId = row.supersedes_id;
      }
      await reply.code(200).send({ data: chain });
    } catch (err) {
      await reply.code(500).send({ error: errorMessage(err) });
    }
  });

  // GET /api/v1/memories/:id — single memory detail
  fastify.get<{ Params: { id: string } }>('/api/v1/memories/:id', async (request, reply) => {
    try {
      const row = deps.raw.prepare(
        'SELECT * FROM memories WHERE id = ?',
      ).get(request.params.id) as MemoryRow | undefined;
      if (!row) { await reply.code(404).send({ error: `Memory '${request.params.id}' not found` }); return; }
      await reply.code(200).send({ data: mapMemoryRow(row) });
    } catch (err) {
      await reply.code(500).send({ error: errorMessage(err) });
    }
  });

  // GET /api/v1/memories — paginated, filterable by team and type
  fastify.get<{
    Querystring: { limit?: string; offset?: string; team?: string; type?: string };
  }>('/api/v1/memories', async (request, reply) => {
    try {
      const limit = clampLimit(request.query.limit);
      const offset = clampOffset(request.query.offset);
      const { team, type } = request.query;

      const conditions: string[] = ['is_active = 1'];
      const params: unknown[] = [];

      if (team) {
        conditions.push('team_name = ?');
        params.push(team);
      }
      if (type) {
        conditions.push('type = ?');
        params.push(type);
      }

      const whereClause = `WHERE ${conditions.join(' AND ')}`;

      const countRow = deps.raw.prepare(
        `SELECT COUNT(*) AS total FROM memories ${whereClause}`,
      ).get(...params) as { total: number };

      const rows = deps.raw.prepare(
        `SELECT * FROM memories ${whereClause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      ).all(...params, limit, offset) as MemoryRow[];

      await reply.code(200).send({ data: rows.map(mapMemoryRow), total: countRow.total });
    } catch (err) {
      await reply.code(500).send({ error: errorMessage(err) });
    }
  });
}
