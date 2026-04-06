/**
 * GET /api/v1/teams — list all teams with org tree structure.
 * GET /api/v1/teams/:name — single team detail with children and scope.
 */

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { OrgTree } from '../domain/org-tree.js';
import type { ITaskQueueStore } from '../domain/interfaces.js';
import { errorMessage } from '../domain/errors.js';
import { TaskStatus } from '../domain/types.js';

export interface TeamsDeps {
  readonly raw: Database.Database;
  readonly orgTree: OrgTree;
  readonly taskQueueStore: ITaskQueueStore;
}

interface TeamSummary {
  readonly teamId: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly status: string;
  readonly childCount: number;
  readonly pendingTasks: number;
}

interface TeamDetail extends TeamSummary {
  readonly children: ReadonlyArray<{ teamId: string; name: string; status: string }>;
  readonly scope: readonly string[];
  readonly tasks: ReadonlyArray<{ id: string; task: string; status: string; priority: string; type: string; createdAt: string }>;
}

export function registerTeamsRoutes(fastify: FastifyInstance, deps: TeamsDeps): void {
  // GET /api/v1/teams — all teams with summary stats
  fastify.get('/api/v1/teams', async (_request, reply) => {
    try {
      const rows = deps.raw.prepare(
        'SELECT id, name, parent_id, status FROM org_tree ORDER BY name',
      ).all() as Array<{ id: string; name: string; parent_id: string | null; status: string }>;

      const teams: TeamSummary[] = rows.map((row) => {
        const children = deps.orgTree.getChildren(row.id);
        const tasks = deps.taskQueueStore.getByTeam(row.id);
        const pendingTasks = tasks.filter(t => t.status === TaskStatus.Pending).length;
        return {
          teamId: row.id,
          name: row.name,
          parentId: row.parent_id,
          status: row.status,
          childCount: children.length,
          pendingTasks,
        };
      });

      await reply.code(200).send({ data: teams, total: teams.length });
    } catch (err) {
      await reply.code(500).send({ error: errorMessage(err) });
    }
  });

  // GET /api/v1/teams/:name — single team detail
  fastify.get<{ Params: { name: string } }>('/api/v1/teams/:name', async (request, reply) => {
    try {
      const { name } = request.params;
      const node = deps.orgTree.getTeam(name);

      if (!node) {
        await reply.code(404).send({ error: `Team '${name}' not found` });
        return;
      }

      const children = deps.orgTree.getChildren(node.teamId);
      const scope = deps.orgTree.getOwnScope(node.teamId);
      const tasks = deps.taskQueueStore.getByTeam(node.teamId);
      const pendingTasks = tasks.filter(t => t.status === TaskStatus.Pending).length;

      const detail: TeamDetail = {
        teamId: node.teamId,
        name: node.name,
        parentId: node.parentId,
        status: node.status,
        childCount: children.length,
        pendingTasks,
        children: children.map(c => ({ teamId: c.teamId, name: c.name, status: c.status })),
        scope,
        tasks: tasks.map(t => ({
          id: t.id,
          task: t.task,
          status: t.status,
          priority: t.priority,
          type: t.type,
          createdAt: t.createdAt,
        })),
      };

      await reply.code(200).send({ data: detail });
    } catch (err) {
      await reply.code(500).send({ error: errorMessage(err) });
    }
  });
}
