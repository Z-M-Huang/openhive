/**
 * GET /api/v1/overview — system overview stats.
 *
 * Returns uptime, SQLite file size, team count, queue depth, and trigger stats.
 */

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { OrgTree } from '../domain/org-tree.js';
import type { ITaskQueueStore, ITriggerConfigStore } from '../domain/interfaces.js';
import { errorMessage } from '../domain/errors.js';

export interface OverviewDeps {
  readonly raw: Database.Database;
  readonly orgTree: OrgTree;
  readonly taskQueueStore: ITaskQueueStore;
  readonly triggerConfigStore: ITriggerConfigStore;
}

interface OverviewData {
  readonly uptime: number;
  readonly sqlite_size: number;
  readonly team_count: number;
  readonly queue_depth: number;
  readonly trigger_stats: {
    readonly total: number;
    readonly active: number;
    readonly disabled: number;
  };
}

export function registerOverviewRoute(fastify: FastifyInstance, deps: OverviewDeps): void {
  fastify.get('/api/v1/overview', async (_request, reply) => {
    try {
      const uptime = Math.floor(process.uptime());

      // SQLite file size via pragma
      let sqliteSize = 0;
      try {
        const row = deps.raw.prepare(
          "SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()",
        ).get() as { size: number } | undefined;
        sqliteSize = row?.size ?? 0;
      } catch {
        // fallback: size unknown
      }

      // Team count from org_tree table
      let teamCount = 0;
      try {
        const row = deps.raw.prepare('SELECT COUNT(*) AS cnt FROM org_tree').get() as { cnt: number } | undefined;
        teamCount = row?.cnt ?? 0;
      } catch {
        // table might not exist in test environments
      }

      // Queue depth: pending tasks
      const pendingTasks = deps.taskQueueStore.getPending();
      const queueDepth = pendingTasks.length;

      // Trigger stats
      const allTriggers = deps.triggerConfigStore.getAll();
      const activeTriggers = allTriggers.filter(t => t.state === 'active');
      const disabledTriggers = allTriggers.filter(t => t.state === 'disabled');

      const data: OverviewData = {
        uptime,
        sqlite_size: sqliteSize,
        team_count: teamCount,
        queue_depth: queueDepth,
        trigger_stats: {
          total: allTriggers.length,
          active: activeTriggers.length,
          disabled: disabledTriggers.length,
        },
      };

      await reply.code(200).send({ data });
    } catch (err) {
      await reply.code(500).send({ error: errorMessage(err) });
    }
  });
}
