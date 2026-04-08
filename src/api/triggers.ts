/**
 * GET  /api/v1/triggers              — paginated trigger list.
 * GET  /api/v1/triggers/:id          — single trigger detail.
 * POST /api/v1/triggers/:id/enable   — set trigger state to 'active'.
 * POST /api/v1/triggers/:id/disable  — set trigger state to 'disabled'.
 */

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { ITriggerConfigStore } from '../domain/interfaces.js';
import { errorMessage } from '../domain/errors.js';

export interface TriggersDeps {
  readonly raw: Database.Database;
  readonly triggerConfigStore: ITriggerConfigStore;
}

interface TriggerRow {
  readonly id: number;
  readonly team: string;
  readonly name: string;
  readonly type: string;
  readonly config: string;
  readonly task: string;
  readonly skill: string | null;
  readonly state: string;
  readonly max_turns: number;
  readonly failure_threshold: number;
  readonly consecutive_failures: number;
  readonly disabled_reason: string | null;
  readonly source_channel_id: string | null;
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

function mapTriggerRow(row: TriggerRow) {
  return {
    id: row.id,
    team: row.team,
    name: row.name,
    type: row.type,
    config: row.config,
    task: row.task,
    skill: row.skill,
    state: row.state,
    maxTurns: row.max_turns,
    failureThreshold: row.failure_threshold,
    consecutiveFailures: row.consecutive_failures,
    disabledReason: row.disabled_reason,
    sourceChannelId: row.source_channel_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function registerTriggersRoutes(fastify: FastifyInstance, deps: TriggersDeps): void {
  // POST /api/v1/triggers/:id/enable — toggle state to active
  fastify.post<{ Params: { id: string } }>('/api/v1/triggers/:id/enable', async (request, reply) => {
    try {
      const row = deps.raw.prepare(
        'SELECT * FROM trigger_configs WHERE id = ?',
      ).get(request.params.id) as TriggerRow | undefined;

      if (!row) { await reply.code(404).send({ error: `Trigger '${request.params.id}' not found` }); return; }

      deps.triggerConfigStore.setState(row.team, row.name, 'active');
      await reply.code(200).send({ data: { id: row.id, state: 'active' } });
    } catch (err) {
      await reply.code(500).send({ error: errorMessage(err) });
    }
  });

  // POST /api/v1/triggers/:id/disable — toggle state to disabled
  fastify.post<{ Params: { id: string } }>('/api/v1/triggers/:id/disable', async (request, reply) => {
    try {
      const row = deps.raw.prepare(
        'SELECT * FROM trigger_configs WHERE id = ?',
      ).get(request.params.id) as TriggerRow | undefined;

      if (!row) { await reply.code(404).send({ error: `Trigger '${request.params.id}' not found` }); return; }

      deps.triggerConfigStore.setState(row.team, row.name, 'disabled');
      await reply.code(200).send({ data: { id: row.id, state: 'disabled' } });
    } catch (err) {
      await reply.code(500).send({ error: errorMessage(err) });
    }
  });

  // GET /api/v1/triggers/:id — single trigger detail
  fastify.get<{ Params: { id: string } }>('/api/v1/triggers/:id', async (request, reply) => {
    try {
      const row = deps.raw.prepare(
        'SELECT * FROM trigger_configs WHERE id = ?',
      ).get(request.params.id) as TriggerRow | undefined;
      if (!row) { await reply.code(404).send({ error: `Trigger '${request.params.id}' not found` }); return; }
      await reply.code(200).send({ data: mapTriggerRow(row) });
    } catch (err) {
      await reply.code(500).send({ error: errorMessage(err) });
    }
  });

  // GET /api/v1/triggers — paginated, filterable by team, state, and name
  fastify.get<{
    Querystring: { limit?: string; offset?: string; team?: string; state?: string; name?: string };
  }>('/api/v1/triggers', async (request, reply) => {
    try {
      const limit = clampLimit(request.query.limit);
      const offset = clampOffset(request.query.offset);
      const { team, state, name } = request.query;

      const conditions: string[] = [];
      const params: unknown[] = [];

      if (team) {
        conditions.push('team = ?');
        params.push(team);
      }
      if (state) {
        conditions.push('state = ?');
        params.push(state);
      }
      if (name) {
        conditions.push('name = ?');
        params.push(name);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const countRow = deps.raw.prepare(
        `SELECT COUNT(*) AS total FROM trigger_configs ${whereClause}`,
      ).get(...params) as { total: number };

      const rows = deps.raw.prepare(
        `SELECT * FROM trigger_configs ${whereClause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      ).all(...params, limit, offset) as TriggerRow[];

      await reply.code(200).send({ data: rows.map(mapTriggerRow), total: countRow.total });
    } catch (err) {
      await reply.code(500).send({ error: errorMessage(err) });
    }
  });
}
