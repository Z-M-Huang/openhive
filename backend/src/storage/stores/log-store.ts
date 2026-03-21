/**
 * LogStore implementation.
 *
 * @module storage/stores/log-store
 */

import { eq, and, lt, lte, gte, desc, asc, sql } from 'drizzle-orm';
import type { Database } from '../database.js';
import * as schema from '../schema.js';
import type { LogStore, LogQueryOpts } from '../../domain/interfaces.js';
import type { LogEntry } from '../../domain/domain.js';
import { rowToLogEntry } from './helpers.js';

export function newLogStore(db: Database): LogStore {
  return {
    async create(entries: LogEntry[]): Promise<void> {
      if (entries.length === 0) return;
      // Delegate to createWithIds and discard the return value
      await this.createWithIds(entries);
    },

    async createWithIds(entries: LogEntry[]): Promise<number[]> {
      if (entries.length === 0) return [];

      return db.enqueueWrite(() => {
        // Batch insert in a single transaction for performance
        const conn = db.getConnection();
        const tx = conn.transaction(() => {
          const ids: number[] = [];
          for (const entry of entries) {
            const result = db.getDB().insert(schema.logEntries).values({
              level: entry.level,
              event_type: entry.event_type,
              component: entry.component,
              action: entry.action,
              message: entry.message,
              params: entry.params,
              team_slug: entry.team_slug,
              task_id: entry.task_id,
              agent_aid: entry.agent_aid,
              request_id: entry.request_id,
              correlation_id: entry.correlation_id,
              error: entry.error,
              duration_ms: entry.duration_ms,
              created_at: entry.created_at,
            }).run();
            ids.push(Number(result.lastInsertRowid));
          }
          return ids;
        });
        return tx();
      });
    },

    async query(opts: LogQueryOpts): Promise<LogEntry[]> {
      const conditions = [];

      if (opts.level !== undefined) {
        conditions.push(gte(schema.logEntries.level, opts.level));
      }
      if (opts.eventType) {
        conditions.push(eq(schema.logEntries.event_type, opts.eventType));
      }
      if (opts.component) {
        conditions.push(eq(schema.logEntries.component, opts.component));
      }
      if (opts.teamSlug) {
        conditions.push(eq(schema.logEntries.team_slug, opts.teamSlug));
      }
      if (opts.taskId) {
        conditions.push(eq(schema.logEntries.task_id, opts.taskId));
      }
      if (opts.agentAid) {
        conditions.push(eq(schema.logEntries.agent_aid, opts.agentAid));
      }
      if (opts.requestId) {
        conditions.push(eq(schema.logEntries.request_id, opts.requestId));
      }
      if (opts.correlationId) {
        conditions.push(eq(schema.logEntries.correlation_id, opts.correlationId));
      }
      if (opts.since) {
        conditions.push(gte(schema.logEntries.created_at, opts.since.getTime()));
      }
      if (opts.until) {
        conditions.push(lte(schema.logEntries.created_at, opts.until.getTime()));
      }

      let query = db.getDB()
        .select()
        .from(schema.logEntries)
        .orderBy(desc(schema.logEntries.created_at))
        .$dynamic();

      if (conditions.length > 0) {
        query = query.where(and(...conditions));
      }

      if (opts.limit) {
        query = query.limit(opts.limit);
      }
      if (opts.offset) {
        query = query.offset(opts.offset);
      }

      const rows = query.all();
      return rows.map(rowToLogEntry);
    },

    async deleteBefore(before: Date): Promise<number> {
      const ts = before.getTime();
      return db.enqueueWrite(() => {
        const result = db.getDB().delete(schema.logEntries)
          .where(lt(schema.logEntries.created_at, ts))
          .run();
        return result.changes;
      });
    },

    async deleteByLevelBefore(level: number, before: Date): Promise<number> {
      const ts = before.getTime();
      return db.enqueueWrite(() => {
        const result = db.getDB().delete(schema.logEntries)
          .where(
            and(
              lte(schema.logEntries.level, level),
              lt(schema.logEntries.created_at, ts),
            )
          )
          .run();
        return result.changes;
      });
    },

    async count(): Promise<number> {
      const result = db.getDB()
        .select({ count: sql<number>`count(*)` })
        .from(schema.logEntries)
        .get();
      return result?.count ?? 0;
    },

    async getOldest(limit: number): Promise<LogEntry[]> {
      const rows = db.getDB()
        .select()
        .from(schema.logEntries)
        .orderBy(asc(schema.logEntries.created_at))
        .limit(limit)
        .all();
      return rows.map(rowToLogEntry);
    },
  };
}
