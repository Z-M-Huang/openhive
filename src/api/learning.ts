/**
 * Learning status API endpoints (AC-28, AC-37).
 *
 * GET /api/v1/learning                   — learning status across all teams
 *   Query: team?, subagent? — optional filters
 * GET /api/v1/learning/:team/journal     — learning journal for a specific team
 *   Query: subagent? — narrow to a single subagent's per-subagent journal
 *
 * The `main` team is excluded from results — main is routing-only (AC-19).
 * Journal keys follow the per-subagent shape `{cycle}:{team}:{subagent}:journal`.
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
  readonly subagent: string | null;
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
  // GET /api/v1/learning — learning status summary across all non-main teams
  fastify.get<{ Querystring: { team?: string; subagent?: string } }>(
    '/api/v1/learning', async (request, reply) => {
      try {
        const { team: teamFilter, subagent: subagentFilter } = request.query;

        // Bug #2: filter learning/reflection cycle triggers by reserved name prefix
        // (the `skill` column no longer exists). `create-trigger` reserves these
        // prefixes for system-seeded triggers, so the name filter is unambiguous.
        const clauses = [
          "(name LIKE 'learning-cycle%' OR name LIKE 'reflection-cycle%')",
          "team != 'main'",
        ];
        const params: string[] = [];
        if (teamFilter) { clauses.push('team = ?'); params.push(teamFilter); }
        if (subagentFilter) { clauses.push('subagent = ?'); params.push(subagentFilter); }

        const triggers = deps.raw.prepare(
          `SELECT name, team, type, state, subagent FROM trigger_configs WHERE ${clauses.join(' AND ')}`,
        ).all(...params) as TriggerConfigRow[];

        const teams = [...new Set(triggers.map(t => t.team))];
        const teamStatus = teams.map(team => {
          const teamTriggers = triggers.filter(t => t.team === team);
          const lastTask = deps.raw.prepare(
            "SELECT id, created_at, status FROM task_queue WHERE team_id = ? AND type = 'trigger' ORDER BY created_at DESC LIMIT 1",
          ).get(team) as TaskRow | undefined;

          return {
            team,
            triggers: teamTriggers.map(t => ({
              name: t.name, state: t.state, subagent: t.subagent,
            })),
            lastTriggerRun: lastTask
              ? { taskId: lastTask.id, createdAt: lastTask.created_at, status: lastTask.status }
              : null,
          };
        });

        await reply.code(200).send({ data: teamStatus });
      } catch (err) {
        await reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // GET /api/v1/learning/:team/journal — per-team (optionally per-subagent) journal entries
  fastify.get<{
    Params: { team: string };
    Querystring: { subagent?: string };
  }>('/api/v1/learning/:team/journal', async (request, reply) => {
    try {
      const { team } = request.params;
      if (team === 'main') {
        await reply.code(200).send({ data: { journal: [], lessons: [] } });
        return;
      }
      const { subagent } = request.query;

      const journalClauses = ['team_name = ?', "(key LIKE 'learning:%' OR key LIKE 'reflection:%')"];
      const journalParams: string[] = [team];
      if (subagent) {
        // Per-subagent keys are shaped `{cycle}:{team}:{subagent}:journal` (AC-37)
        journalClauses.push('(key LIKE ? OR key LIKE ?)');
        journalParams.push(`learning:${team}:${subagent}:%`, `reflection:${team}:${subagent}:%`);
      }

      const journalEntries = deps.raw.prepare(
        `SELECT key, value, updated_at FROM team_vault WHERE ${journalClauses.join(' AND ')} ORDER BY updated_at DESC`,
      ).all(...journalParams) as VaultRow[];

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
