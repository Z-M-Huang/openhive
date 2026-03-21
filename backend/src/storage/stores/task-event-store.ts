/**
 * TaskEventStore implementation.
 *
 * @module storage/stores/task-event-store
 */

import { eq, asc } from 'drizzle-orm';
import type { Database } from '../database.js';
import * as schema from '../schema.js';
import type { TaskEventStore } from '../../domain/interfaces.js';
import type { TaskEvent } from '../../domain/domain.js';

export function newTaskEventStore(db: Database): TaskEventStore {
  return {
    async create(event: TaskEvent): Promise<void> {
      await db.enqueueWrite(() => {
        db.getDB().insert(schema.taskEvents).values({
          log_entry_id: event.log_entry_id,
          task_id: event.task_id,
          from_status: event.from_status,
          to_status: event.to_status,
          agent_aid: event.agent_aid,
          reason: event.reason,
          created_at: event.created_at,
        }).run();
      });
    },

    async getByTask(taskId: string): Promise<TaskEvent[]> {
      const rows = db.getDB()
        .select()
        .from(schema.taskEvents)
        .where(eq(schema.taskEvents.task_id, taskId))
        .orderBy(asc(schema.taskEvents.created_at))
        .all();
      return rows as TaskEvent[];
    },

    async getByLogEntry(logEntryId: number): Promise<TaskEvent | null> {
      const row = db.getDB()
        .select()
        .from(schema.taskEvents)
        .where(eq(schema.taskEvents.log_entry_id, logEntryId))
        .get();
      return (row as TaskEvent) ?? null;
    },
  };
}
