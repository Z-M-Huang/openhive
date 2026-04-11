/**
 * Learning status API endpoints.
 *
 * GET /api/v1/learning           — learning status across all teams
 * GET /api/v1/learning/:team/journal — learning journal for a specific team
 */

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { errorMessage } from '../domain/errors.js';

export interface LearningDeps {
  readonly raw: Database.Database;
}

interface TriggerConfigRow {
  readonly name: string;
  readonly team: string;
  readonly type: string;
  readonly state: string;
  readonly skill: string | null;
}

interface VaultRow {
  readonly key: string;
  readonly value: string;
  readonly updated_at: string;
}

interface TaskRow {
  readonly id: string;
  readonly created_at: string;
  readonly status: string;
}

export function registerLearningRoutes(fastify: FastifyInstance, deps: LearningDeps): void {
  // GET /api/v1/learning — learning status summary across all teams
  fastify.get('/api/v1/learning', async (_request, reply) => {
    try {
      // Find all learning/reflection triggers
      const triggers = deps.raw.prepare(
        "SELECT name, team, type, state, skill FROM trigger_configs WHERE skill IN ('learning-cycle', 'reflection-cycle')",
      ).all() as TriggerConfigRow[];

      // Get last learning task per team
      const teams = [...new Set(triggers.map(t => t.team))];
      const teamStatus = teams.map(team => {
        const teamTriggers = triggers.filter(t => t.team === team);
        const lastTask = deps.raw.prepare(
          "SELECT id, created_at, status FROM task_queue WHERE team_id = ? AND type = 'trigger' ORDER BY created_at DESC LIMIT 1",
        ).get(team) as TaskRow | undefined;

        return {
          team,
          triggers: teamTriggers.map(t => ({ name: t.name, skill: t.skill, state: t.state })),
          lastTriggerRun: lastTask ? { taskId: lastTask.id, createdAt: lastTask.created_at, status: lastTask.status } : null,
        };
      });

      await reply.code(200).send({ data: teamStatus });
    } catch (err) {
      await reply.code(500).send({ error: errorMessage(err) });
    }
  });

  // GET /api/v1/learning/:team/journal — learning journal entries for a team
  fastify.get<{
    Params: { team: string };
  }>('/api/v1/learning/:team/journal', async (request, reply) => {
    try {
      const { team } = request.params;

      // Get learning and reflection journal from vault
      const journalEntries = deps.raw.prepare(
        "SELECT key, value, updated_at FROM team_vault WHERE team_name = ? AND (key LIKE 'learning:%' OR key LIKE 'reflection:%') ORDER BY updated_at DESC",
      ).all(team) as VaultRow[];

      // Get learning-related memories
      const memories = deps.raw.prepare(
        "SELECT key, content, created_at FROM memories WHERE team_name = ? AND key LIKE 'lesson:%' AND is_active = 1 ORDER BY created_at DESC LIMIT 50",
      ).all(team) as Array<{ key: string; content: string; created_at: string }>;

      await reply.code(200).send({
        data: {
          journal: journalEntries.map(e => ({ key: e.key, value: e.value, updatedAt: e.updated_at })),
          lessons: memories.map(m => ({ key: m.key, content: m.content, createdAt: m.created_at })),
        },
      });
    } catch (err) {
      await reply.code(500).send({ error: errorMessage(err) });
    }
  });
}
