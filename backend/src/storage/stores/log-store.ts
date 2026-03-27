/**
 * Log store — SQLite-backed implementation of ILogStore.
 *
 * Appends structured log entries and supports filtered queries.
 */

import { eq, gte, desc, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { ILogStore, LogFilter } from '../../domain/interfaces.js';
import type { LogEntry } from '../../domain/types.js';
import * as schema from '../schema.js';

export class LogStore implements ILogStore {
  constructor(private readonly db: BetterSQLite3Database<typeof schema>) {}

  append(entry: LogEntry): void {
    const durationMs = typeof entry.metadata?.['durationMs'] === 'number'
      ? entry.metadata['durationMs'] as number
      : null;
    this.db.insert(schema.logEntries).values({
      level: entry.level,
      message: entry.message,
      context: entry.metadata ? JSON.stringify(entry.metadata) : null,
      durationMs,
      createdAt: new Date(entry.timestamp).toISOString(),
    }).run();
  }

  query(opts: LogFilter): LogEntry[] {
    const conditions: ReturnType<typeof eq>[] = [];

    if (opts.level) {
      conditions.push(eq(schema.logEntries.level, opts.level));
    }
    if (opts.since !== undefined) {
      conditions.push(
        gte(schema.logEntries.createdAt, new Date(opts.since).toISOString()),
      );
    }

    const where = conditions.length > 0
      ? sql.join(conditions, sql` AND `)
      : undefined;

    const rows = this.db
      .select()
      .from(schema.logEntries)
      .where(where)
      .orderBy(desc(schema.logEntries.createdAt))
      .limit(opts.limit ?? 100)
      .all();

    return rows.map((r) => ({
      id: String(r.id),
      level: r.level as LogEntry['level'],
      message: r.message,
      timestamp: new Date(r.createdAt).getTime(),
      source: '',
      metadata: r.context ? JSON.parse(r.context) as Record<string, unknown> : undefined,
    }));
  }
}
