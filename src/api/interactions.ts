/**
 * GET /api/v1/interactions — paginated interaction list with optional filters.
 */

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { errorMessage } from '../domain/errors.js';

export interface InteractionsDeps {
  readonly raw: Database.Database;
}

interface InteractionRow {
  readonly id: number;
  readonly direction: string;
  readonly channel_type: string;
  readonly channel_id: string;
  readonly user_id: string | null;
  readonly team_id: string | null;
  readonly content_snippet: string | null;
  readonly content_length: number | null;
  readonly duration_ms: number | null;
  readonly topic_id: string | null;
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

function mapInteractionRow(row: InteractionRow) {
  return {
    id: row.id,
    direction: row.direction,
    channelType: row.channel_type,
    channelId: row.channel_id,
    userId: row.user_id,
    teamId: row.team_id,
    contentSnippet: row.content_snippet,
    contentLength: row.content_length,
    durationMs: row.duration_ms,
    topicId: row.topic_id,
    createdAt: row.created_at,
  };
}

export function registerInteractionsRoutes(fastify: FastifyInstance, deps: InteractionsDeps): void {
  // GET /api/v1/interactions — paginated, filterable by channel, direction
  fastify.get<{
    Querystring: { limit?: string; offset?: string; channel?: string; direction?: string; topic?: string };
  }>('/api/v1/interactions', async (request, reply) => {
    try {
      const limit = clampLimit(request.query.limit);
      const offset = clampOffset(request.query.offset);
      const { channel, direction, topic } = request.query;

      const conditions: string[] = [];
      const params: unknown[] = [];

      if (channel) {
        conditions.push('channel_id = ?');
        params.push(channel);
      }
      if (direction) {
        conditions.push('direction = ?');
        params.push(direction);
      }
      if (topic) {
        conditions.push('topic_id = ?');
        params.push(topic);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const countRow = deps.raw.prepare(
        `SELECT COUNT(*) AS total FROM channel_interactions ${whereClause}`,
      ).get(...params) as { total: number };

      const rows = deps.raw.prepare(
        `SELECT * FROM channel_interactions ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ).all(...params, limit, offset) as InteractionRow[];

      await reply.code(200).send({ data: rows.map(mapInteractionRow), total: countRow.total });
    } catch (err) {
      await reply.code(500).send({ error: errorMessage(err) });
    }
  });
}
