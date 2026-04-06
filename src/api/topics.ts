/**
 * GET /api/v1/topics     — list all topics, optionally filtered by channel.
 * GET /api/v1/topics/:id — single topic detail.
 */

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { errorMessage } from '../domain/errors.js';

export interface TopicsDeps {
  readonly raw: Database.Database;
}

interface TopicRow {
  readonly id: string;
  readonly channel_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly state: string;
  readonly created_at: string;
  readonly last_activity: string;
}

function clampLimit(raw: unknown): number {
  const n = Number(raw) || 50;
  return Math.max(1, Math.min(n, 100));
}

function clampOffset(raw: unknown): number {
  const n = Number(raw) || 0;
  return Math.max(0, n);
}

function mapTopicRow(row: TopicRow) {
  return {
    id: row.id,
    channelId: row.channel_id,
    name: row.name,
    description: row.description,
    state: row.state,
    createdAt: row.created_at,
    lastActivity: row.last_activity,
  };
}

export function registerTopicsRoutes(fastify: FastifyInstance, deps: TopicsDeps): void {
  // GET /api/v1/topics/:id — single topic detail
  fastify.get<{ Params: { id: string } }>('/api/v1/topics/:id', async (request, reply) => {
    try {
      const row = deps.raw.prepare(
        'SELECT * FROM topics WHERE id = ?',
      ).get(request.params.id) as TopicRow | undefined;
      if (!row) { await reply.code(404).send({ error: `Topic '${request.params.id}' not found` }); return; }
      await reply.code(200).send({ data: mapTopicRow(row) });
    } catch (err) {
      await reply.code(500).send({ error: errorMessage(err) });
    }
  });

  // GET /api/v1/topics — paginated, optionally filtered by channel
  fastify.get<{
    Querystring: { limit?: string; offset?: string; channel?: string };
  }>('/api/v1/topics', async (request, reply) => {
    try {
      const limit = clampLimit(request.query.limit);
      const offset = clampOffset(request.query.offset);
      const { channel } = request.query;

      const conditions: string[] = [];
      const params: unknown[] = [];

      if (channel) {
        conditions.push('channel_id = ?');
        params.push(channel);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const countRow = deps.raw.prepare(
        `SELECT COUNT(*) AS total FROM topics ${whereClause}`,
      ).get(...params) as { total: number };

      const rows = deps.raw.prepare(
        `SELECT * FROM topics ${whereClause} ORDER BY last_activity DESC LIMIT ? OFFSET ?`,
      ).all(...params, limit, offset) as TopicRow[];

      await reply.code(200).send({ data: rows.map(mapTopicRow), total: countRow.total });
    } catch (err) {
      await reply.code(500).send({ error: errorMessage(err) });
    }
  });
}
