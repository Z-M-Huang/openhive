/**
 * TaskStore implementation.
 *
 * @module storage/stores/task-store
 */

import { eq, and, desc, asc, sql } from 'drizzle-orm';
import type { Database } from '../database.js';
import * as schema from '../schema.js';
import type { TaskStore } from '../../domain/interfaces.js';
import type { Task } from '../../domain/domain.js';
import type { TaskStatus } from '../../domain/enums.js';
import { NotFoundError, CycleDetectedError } from '../../domain/errors.js';
import { assertValidTransition } from '../../domain/domain.js';
import { parseBlockedBy, rowToTask } from './helpers.js';

export function newTaskStore(db: Database): TaskStore {
  return {
    async create(task: Task): Promise<void> {
      // Validate dependencies if any
      if (task.blocked_by && task.blocked_by.length > 0) {
        await this.validateDependencies(task.id, task.blocked_by);
      }

      await db.enqueueWrite(() => {
        db.getDB().insert(schema.tasks).values({
          id: task.id,
          parent_id: task.parent_id,
          team_slug: task.team_slug,
          agent_aid: task.agent_aid,
          title: task.title,
          status: task.status,
          prompt: task.prompt,
          result: task.result,
          error: task.error,
          blocked_by: task.blocked_by ? JSON.stringify(task.blocked_by) : null,
          priority: task.priority,
          retry_count: task.retry_count,
          max_retries: task.max_retries,
          created_at: task.created_at,
          updated_at: task.updated_at,
          completed_at: task.completed_at,
          origin_chat_jid: task.origin_chat_jid ?? null,
        }).run();
      });
    },

    async get(id: string): Promise<Task> {
      const row = db.getDB()
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.id, id))
        .get();
      if (!row) {
        throw new NotFoundError(`Task not found: ${id}`);
      }
      return rowToTask(row);
    },

    async update(task: Task): Promise<void> {
      // Validate state transition
      const existing = db.getDB()
        .select({ status: schema.tasks.status })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, task.id))
        .get();
      if (!existing) {
        throw new NotFoundError(`Task not found: ${task.id}`);
      }
      if (existing.status !== task.status) {
        assertValidTransition(existing.status as TaskStatus, task.status);
      }

      await db.enqueueWrite(() => {
        db.getDB().update(schema.tasks)
          .set({
            parent_id: task.parent_id,
            team_slug: task.team_slug,
            agent_aid: task.agent_aid,
            title: task.title,
            status: task.status,
            prompt: task.prompt,
            result: task.result,
            error: task.error,
            blocked_by: task.blocked_by ? JSON.stringify(task.blocked_by) : null,
            priority: task.priority,
            retry_count: task.retry_count,
            max_retries: task.max_retries,
            updated_at: task.updated_at,
            completed_at: task.completed_at,
          })
          .where(eq(schema.tasks.id, task.id))
          .run();
      });
    },

    async delete(id: string): Promise<void> {
      await db.enqueueWrite(() => {
        db.getDB().delete(schema.tasks).where(eq(schema.tasks.id, id)).run();
      });
    },

    async listByTeam(teamSlug: string): Promise<Task[]> {
      const rows = db.getDB()
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.team_slug, teamSlug))
        .all();
      return rows.map(rowToTask);
    },

    async listByStatus(status: TaskStatus): Promise<Task[]> {
      const rows = db.getDB()
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.status, status))
        .all();
      return rows.map(rowToTask);
    },

    async getSubtree(rootID: string): Promise<Task[]> {
      // Recursive CTE to get task + all descendants
      const conn = db.getConnection();
      const stmt = conn.prepare(`
        WITH RECURSIVE subtree AS (
          SELECT * FROM tasks WHERE id = ?
          UNION ALL
          SELECT t.* FROM tasks t
          JOIN subtree s ON t.parent_id = s.id
        )
        SELECT * FROM subtree
      `);
      const rows = stmt.all(rootID) as Array<typeof schema.tasks.$inferSelect>;
      return rows.map(rowToTask);
    },

    async getBlockedBy(taskId: string): Promise<string[]> {
      const row = db.getDB()
        .select({ blocked_by: schema.tasks.blocked_by })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, taskId))
        .get();
      if (!row) {
        throw new NotFoundError(`Task not found: ${taskId}`);
      }
      return parseBlockedBy(row.blocked_by);
    },

    async unblockTask(taskId: string, completedDependencyId: string): Promise<boolean> {
      return db.enqueueWrite(() => {
        const row = db.getDB()
          .select({ blocked_by: schema.tasks.blocked_by })
          .from(schema.tasks)
          .where(eq(schema.tasks.id, taskId))
          .get();
        if (!row) {
          throw new NotFoundError(`Task not found: ${taskId}`);
        }

        const blockers = parseBlockedBy(row.blocked_by);
        const idx = blockers.indexOf(completedDependencyId);
        if (idx === -1) return false;

        blockers.splice(idx, 1);
        const newBlockedBy = blockers.length > 0 ? JSON.stringify(blockers) : null;

        db.getDB().update(schema.tasks)
          .set({
            blocked_by: newBlockedBy,
            updated_at: Date.now(),
          })
          .where(eq(schema.tasks.id, taskId))
          .run();

        // Return true if task is now fully unblocked
        return blockers.length === 0;
      });
    },

    async retryTask(taskId: string): Promise<boolean> {
      return db.enqueueWrite(() => {
        const row = db.getDB()
          .select({
            status: schema.tasks.status,
            retry_count: schema.tasks.retry_count,
            max_retries: schema.tasks.max_retries,
          })
          .from(schema.tasks)
          .where(eq(schema.tasks.id, taskId))
          .get();
        if (!row) {
          throw new NotFoundError(`Task not found: ${taskId}`);
        }

        if (row.retry_count >= row.max_retries) {
          return false;
        }

        // Transition back to pending
        assertValidTransition(row.status as TaskStatus, 'pending' as TaskStatus);

        db.getDB().update(schema.tasks)
          .set({
            status: 'pending',
            retry_count: row.retry_count + 1,
            updated_at: Date.now(),
          })
          .where(eq(schema.tasks.id, taskId))
          .run();

        return true;
      });
    },

    async validateDependencies(taskId: string, blockedByIds: string[]): Promise<void> {
      // Verify all referenced tasks exist
      for (const depId of blockedByIds) {
        const exists = db.getDB()
          .select({ id: schema.tasks.id })
          .from(schema.tasks)
          .where(eq(schema.tasks.id, depId))
          .get();
        if (!exists) {
          throw new NotFoundError(`Dependency task not found: ${depId}`);
        }
      }

      // DFS cycle detection: from each blocker, walk the dependency graph
      // checking if we can reach back to taskId
      const visited = new Set<string>();

      const dfs = (currentId: string, path: string[]): void => {
        if (currentId === taskId) {
          throw new CycleDetectedError(
            `Dependency cycle detected: ${[...path, taskId].join(' -> ')}`
          );
        }
        if (visited.has(currentId)) return;
        visited.add(currentId);

        const row = db.getDB()
          .select({ blocked_by: schema.tasks.blocked_by })
          .from(schema.tasks)
          .where(eq(schema.tasks.id, currentId))
          .get();
        if (!row) return;

        const deps = parseBlockedBy(row.blocked_by);
        for (const dep of deps) {
          dfs(dep, [...path, currentId]);
        }
      };

      for (const blockerId of blockedByIds) {
        visited.clear();
        dfs(blockerId, [taskId]);
      }
    },

    async getRecentUserTasks(agentAid: string, limit: number): Promise<Task[]> {
      const rows = db.getDB()
        .select()
        .from(schema.tasks)
        .where(
          and(
            eq(schema.tasks.agent_aid, agentAid),
            sql`${schema.tasks.origin_chat_jid} IS NOT NULL`,
            sql`(${schema.tasks.parent_id} IS NULL OR ${schema.tasks.parent_id} = '')`,
            eq(schema.tasks.status, 'completed'),
          )
        )
        .orderBy(desc(schema.tasks.created_at))
        .limit(limit)
        .all();
      return rows.map(rowToTask);
    },

    async getNextPendingForAgent(agentAid: string): Promise<Task | null> {
      const rows = db.getDB()
        .select()
        .from(schema.tasks)
        .where(
          and(
            eq(schema.tasks.agent_aid, agentAid),
            eq(schema.tasks.status, 'pending'),
          )
        )
        .orderBy(asc(schema.tasks.created_at))
        .limit(1)
        .all();
      return rows.length > 0 ? rowToTask(rows[0]) : null;
    },
  };
}
