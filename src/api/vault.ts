/**
 * GET /api/v1/vault — paginated vault list with optional team filter.
 *
 * Secret values (is_secret = 1) are redacted to "[REDACTED]".
 */

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { errorMessage } from '../domain/errors.js';

export interface VaultDeps {
  readonly raw: Database.Database;
}

interface VaultRow {
  readonly id: number;
  readonly team_name: string;
  readonly key: string;
  readonly value: string;
  readonly is_secret: number;
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

function mapVaultRow(row: VaultRow) {
  return {
    id: row.id,
    teamName: row.team_name,
    key: row.key,
    value: row.is_secret === 1 ? '[REDACTED]' : row.value,
    isSecret: row.is_secret === 1,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function registerVaultRoutes(fastify: FastifyInstance, deps: VaultDeps): void {
  // GET /api/v1/vault — paginated, filterable by team
  fastify.get<{
    Querystring: { limit?: string; offset?: string; team?: string };
  }>('/api/v1/vault', async (request, reply) => {
    try {
      const limit = clampLimit(request.query.limit);
      const offset = clampOffset(request.query.offset);
      const { team } = request.query;

      const conditions: string[] = [];
      const params: unknown[] = [];

      if (team) {
        conditions.push('team_name = ?');
        params.push(team);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const countRow = deps.raw.prepare(
        `SELECT COUNT(*) AS total FROM team_vault ${whereClause}`,
      ).get(...params) as { total: number };

      const rows = deps.raw.prepare(
        `SELECT * FROM team_vault ${whereClause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      ).all(...params, limit, offset) as VaultRow[];

      await reply.code(200).send({ data: rows.map(mapVaultRow), total: countRow.total });
    } catch (err) {
      await reply.code(500).send({ error: errorMessage(err) });
    }
  });
}
