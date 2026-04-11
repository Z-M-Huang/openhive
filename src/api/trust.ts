/**
 * GET /api/v1/trust/audit — query trust audit log with optional filters.
 */

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { errorMessage } from '../domain/errors.js';

export interface TrustDeps {
  readonly raw: Database.Database;
}

interface TrustAuditRow {
  readonly id: number;
  readonly channel_type: string;
  readonly channel_id: string;
  readonly sender_id: string;
  readonly decision: string;
  readonly reason: string;
  readonly created_at: string;
}

export function registerTrustRoutes(fastify: FastifyInstance, deps: TrustDeps): void {
  fastify.get<{
    Querystring: { since?: string; decision?: string; limit?: string };
  }>('/api/v1/trust/audit', async (request, reply) => {
    try {
      const { since, decision } = request.query;
      const limit = Math.max(1, Math.min(Number(request.query.limit) || 50, 200));

      const conditions: string[] = [];
      const params: unknown[] = [];

      if (since) {
        conditions.push('created_at >= ?');
        params.push(since);
      }
      if (decision) {
        conditions.push('decision = ?');
        params.push(decision);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const rows = deps.raw.prepare(
        `SELECT * FROM trust_audit_log ${whereClause} ORDER BY created_at DESC LIMIT ?`,
      ).all(...params, limit) as TrustAuditRow[];

      const data = rows.map((row) => ({
        id: row.id,
        channelType: row.channel_type,
        channelId: row.channel_id,
        senderId: row.sender_id,
        decision: row.decision,
        reason: row.reason,
        createdAt: row.created_at,
      }));

      await reply.code(200).send({ data });
    } catch (err) {
      await reply.code(500).send({ error: errorMessage(err) });
    }
  });
}
