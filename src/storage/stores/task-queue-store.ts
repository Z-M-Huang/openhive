/**
 * Task queue store — SQLite-backed implementation of ITaskQueueStore.
 *
 * Priority ordering: critical > high > normal > low, then FIFO within same priority.
 */

import { eq, and, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { randomBytes } from 'node:crypto';
import type { ITaskQueueStore } from '../../domain/interfaces.js';
import type { TaskEntry, TaskOptions, TaskType, TaskPriority } from '../../domain/types.js';
import { TaskStatus } from '../../domain/types.js';
import { safeJsonParse } from '../../domain/safe-json.js';
import * as schema from '../schema.js';

export class TaskQueueStore implements ITaskQueueStore {
  constructor(private readonly db: BetterSQLite3Database<typeof schema>) {}

  enqueue(
    teamId: string,
    task: string,
    priority: TaskPriority,
    type: TaskType,
    sourceChannelId?: string,
    correlationId?: string,
    options?: TaskOptions,
  ): string {
    const id = `task-${randomBytes(8).toString('hex')}`;

    this.db.insert(schema.taskQueue).values({
      id,
      teamId,
      task,
      priority,
      type,
      status: TaskStatus.Pending,
      createdAt: new Date().toISOString(),
      correlationId: correlationId ?? null,
      options: options ? JSON.stringify(options) : null,
      sourceChannelId: sourceChannelId ?? null,
    }).run();
    return id;
  }

  dequeue(teamId: string): TaskEntry | undefined {
    const row = this.db
      .select()
      .from(schema.taskQueue)
      .where(
        and(
          eq(schema.taskQueue.teamId, teamId),
          eq(schema.taskQueue.status, TaskStatus.Pending),
        ),
      )
      .orderBy(
        sql`CASE ${schema.taskQueue.priority}
          WHEN 'critical' THEN 0
          WHEN 'high' THEN 1
          WHEN 'normal' THEN 2
          WHEN 'low' THEN 3
          ELSE 4 END`,
        schema.taskQueue.createdAt,
      )
      .limit(1)
      .get();

    if (!row) return undefined;

    this.db
      .update(schema.taskQueue)
      .set({ status: TaskStatus.Running })
      .where(eq(schema.taskQueue.id, row.id))
      .run();

    return this.rowToEntry({ ...row, status: TaskStatus.Running });
  }

  peek(teamId: string): TaskEntry | undefined {
    const row = this.db
      .select()
      .from(schema.taskQueue)
      .where(
        and(
          eq(schema.taskQueue.teamId, teamId),
          eq(schema.taskQueue.status, TaskStatus.Pending),
        ),
      )
      .orderBy(
        sql`CASE ${schema.taskQueue.priority}
          WHEN 'critical' THEN 0
          WHEN 'high' THEN 1
          WHEN 'normal' THEN 2
          WHEN 'low' THEN 3
          ELSE 4 END`,
        schema.taskQueue.createdAt,
      )
      .limit(1)
      .get();

    if (!row) return undefined;
    return this.rowToEntry(row);
  }

  getByTeam(teamId: string): TaskEntry[] {
    const rows = this.db
      .select()
      .from(schema.taskQueue)
      .where(eq(schema.taskQueue.teamId, teamId))
      .all();

    return rows.map((r) => this.rowToEntry(r));
  }

  updateStatus(taskId: string, status: TaskStatus): void {
    this.db
      .update(schema.taskQueue)
      .set({ status })
      .where(eq(schema.taskQueue.id, taskId))
      .run();
  }

  updateResult(taskId: string, result: string): void {
    this.db
      .update(schema.taskQueue)
      .set({ result })
      .where(eq(schema.taskQueue.id, taskId))
      .run();
  }

  updateDuration(taskId: string, durationMs: number): void {
    this.db
      .update(schema.taskQueue)
      .set({ durationMs })
      .where(eq(schema.taskQueue.id, taskId))
      .run();
  }

  getPending(): TaskEntry[] {
    return this.getByStatus(TaskStatus.Pending);
  }

  getByStatus(status: TaskStatus): TaskEntry[] {
    const rows = this.db
      .select()
      .from(schema.taskQueue)
      .where(eq(schema.taskQueue.status, status))
      .all();

    return rows.map((r) => this.rowToEntry(r));
  }

  removeByTeam(teamId: string): void {
    this.db.delete(schema.taskQueue).where(eq(schema.taskQueue.teamId, teamId)).run();
  }

  private rowToEntry(row: {
    id: string;
    teamId: string;
    task: string;
    priority: string;
    type: string;
    status: string;
    createdAt: string;
    correlationId: string | null;
    result: string | null;
    durationMs: number | null;
    options: string | null;
    sourceChannelId: string | null;
  }): TaskEntry {
    return {
      id: row.id,
      teamId: row.teamId,
      task: row.task,
      priority: (row.priority as TaskPriority) || 'normal',
      type: (row.type as TaskType) || 'delegate',
      status: (row.status as TaskStatus) || TaskStatus.Pending,
      createdAt: row.createdAt,
      correlationId: row.correlationId,
      result: row.result,
      durationMs: row.durationMs,
      options: row.options ? safeJsonParse<TaskOptions>(row.options, 'task-queue-options') ?? null : null,
      sourceChannelId: row.sourceChannelId ?? null,
    };
  }
}
