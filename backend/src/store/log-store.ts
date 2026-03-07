/**
 * OpenHive Backend - Log Store
 *
 * Implements the LogStore interface using Drizzle ORM and better-sqlite3.
 *
 * Design notes:
 *   - LogLevel is stored as an integer in the DB:
 *     debug=0, info=1, warn=2, error=3 (from LOG_LEVELS array in enums.ts).
 *   - create() is a batch insert — all entries are inserted in a single
 *     better-sqlite3 transaction for performance. ID is omitted (autoincrement).
 *   - query() builds a dynamic WHERE clause using Drizzle's and() to compose
 *     conditions — only defined/non-empty opts fields add conditions.
 *   - deleteBefore() returns the count of deleted rows.
 *   - count() returns the total number of log_entries rows.
 *   - getOldest() returns N entries in chronological (ASC) order.
 *   - params column is stored as a JSON string in the DB (text type); it is
 *     parsed to JsonValue on read and serialized on write. Empty string means
 *     no params.
 *   - Optional string fields (team_name, task_id, agent_name, request_id,
 *     error) are stored as empty strings (NOT NULL DEFAULT '') and converted
 *     to undefined on read.
 *   - reader defaults to db.writer for in-memory test compatibility.
 */

import { and, gte, lte, lt, eq, asc, desc, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { DB } from './db.js';
import { log_entries } from './schema.js';
import type * as schema from './schema.js';

import { LOG_LEVELS } from '../domain/enums.js';
import type { LogLevel } from '../domain/enums.js';
import type { LogEntry, LogQueryOpts, JsonValue } from '../domain/types.js';
import type { LogStore } from '../domain/interfaces.js';

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

/**
 * logLevelToInt converts a TypeScript LogLevel string to the integer value
 * stored in the database:
 *   debug=0, info=1, warn=2, error=3
 */
function logLevelToInt(level: LogLevel): number {
  return LOG_LEVELS.indexOf(level);
}

/**
 * intToLogLevel converts a database integer back to the TypeScript LogLevel
 * string. Returns 'debug' as a safe default for out-of-range values.
 */
function intToLogLevel(n: number): LogLevel {
  const level = LOG_LEVELS[n];
  if (level === undefined) {
    return 'debug';
  }
  return level;
}

/**
 * parseParams parses the params column (JSON string) back to JsonValue.
 * Returns undefined for empty strings.
 */
function parseParams(raw: string): JsonValue | undefined {
  if (raw === '') {
    return undefined;
  }
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    // Treat malformed JSON as undefined — should never happen in a healthy DB.
    return undefined;
  }
}

/**
 * serializeParams serializes a JsonValue to a JSON string for DB storage.
 * Returns empty string for undefined (matching NOT NULL DEFAULT '').
 */
function serializeParams(params: JsonValue | undefined): string {
  if (params === undefined) {
    return '';
  }
  return JSON.stringify(params);
}

/**
 * logEntryRowToDomain converts a Drizzle-typed row (from schema.log_entries)
 * to a domain LogEntry. Drizzle's integer(mode:'timestamp_ms') maps the
 * integer column to a Date automatically. Empty strings for optional text
 * fields are converted to undefined.
 */
function logEntryRowToDomain(row: typeof log_entries.$inferSelect): LogEntry {
  return {
    id: row.id,
    level: intToLogLevel(row.level),
    component: row.component,
    action: row.action,
    message: row.message,
    params: parseParams(row.params),
    team_name: row.team_name !== '' ? row.team_name : undefined,
    task_id: row.task_id !== '' ? row.task_id : undefined,
    agent_name: row.agent_name !== '' ? row.agent_name : undefined,
    request_id: row.request_id !== '' ? row.request_id : undefined,
    error: row.error !== '' ? row.error : undefined,
    duration_ms: row.duration_ms !== 0 ? row.duration_ms : undefined,
    created_at: row.created_at,
  };
}

/**
 * logEntryToInsertRow converts a domain LogEntry to the Drizzle insert shape
 * for schema.log_entries. The id field is omitted to let AUTOINCREMENT handle
 * it. Optional string fields become empty strings (NOT NULL DEFAULT '').
 * duration_ms=0 is stored as-is (default).
 */
function logEntryToInsertRow(
  entry: LogEntry,
): Omit<typeof log_entries.$inferInsert, 'id'> {
  return {
    level: logLevelToInt(entry.level),
    component: entry.component,
    action: entry.action,
    message: entry.message,
    params: serializeParams(entry.params),
    team_name: entry.team_name ?? '',
    task_id: entry.task_id ?? '',
    agent_name: entry.agent_name ?? '',
    request_id: entry.request_id ?? '',
    error: entry.error ?? '',
    duration_ms: entry.duration_ms ?? 0,
    created_at: entry.created_at,
  };
}

// ---------------------------------------------------------------------------
// LogStoreImpl
// ---------------------------------------------------------------------------

/**
 * LogStoreImpl implements domain.LogStore using Drizzle ORM.
 *
 * The reader parameter defaults to db.writer. When using a file-based DB
 * with WAL mode, pass db.reader for concurrent read performance. When using
 * newInMemoryDB() in tests, always use db.writer (the two in-memory
 * connections are independent and do not share data).
 */
export class LogStoreImpl implements LogStore {
  private readonly writer: BetterSQLite3Database<typeof schema>;
  private readonly reader: BetterSQLite3Database<typeof schema>;

  constructor(db: DB, reader?: BetterSQLite3Database<typeof schema>) {
    this.writer = db.writer;
    // Default reader to writer so in-memory tests see consistent data.
    this.reader = reader ?? db.writer;
  }

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  /**
   * create batch-inserts log entries. No-op for an empty array.
   * Each entry's ID is omitted so SQLite AUTOINCREMENT assigns it.
   * Implements LogStore.create
   */
  async create(entries: LogEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    const rows = entries.map(logEntryToInsertRow);
    this.writer.insert(log_entries).values(rows).run();
  }

  // -------------------------------------------------------------------------
  // query
  // -------------------------------------------------------------------------

  /**
   * query retrieves log entries matching the given filter options.
   * Builds a dynamic WHERE clause by composing only the conditions that
   * correspond to non-null/non-empty opts fields.
   * Default limit is 100 when opts.limit is 0 or undefined.
   */
  async query(opts: LogQueryOpts): Promise<LogEntry[]> {
    const conditions: SQL[] = [];

    if (opts.level !== undefined) {
      conditions.push(gte(log_entries.level, logLevelToInt(opts.level)));
    }
    if (opts.component !== undefined && opts.component !== '') {
      conditions.push(eq(log_entries.component, opts.component));
    }
    if (opts.team_name !== undefined && opts.team_name !== '') {
      conditions.push(eq(log_entries.team_name, opts.team_name));
    }
    if (opts.agent_name !== undefined && opts.agent_name !== '') {
      conditions.push(eq(log_entries.agent_name, opts.agent_name));
    }
    if (opts.task_id !== undefined && opts.task_id !== '') {
      conditions.push(eq(log_entries.task_id, opts.task_id));
    }
    if (opts.since != null) {
      conditions.push(gte(log_entries.created_at, opts.since));
    }
    if (opts.until != null) {
      conditions.push(lte(log_entries.created_at, opts.until));
    }

    const limit = opts.limit != null && opts.limit > 0 ? opts.limit : 100;
    const offset = opts.offset != null && opts.offset > 0 ? opts.offset : 0;
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Build the query incrementally. Each Drizzle step returns a new builder
    // so we hold a reference to the base builder and call additional methods
    // only when necessary, avoiding type assertion casts.
    const base = this.reader
      .select()
      .from(log_entries)
      .where(whereClause)
      .orderBy(desc(log_entries.created_at))
      .limit(limit)
      .offset(offset);

    const rows = base.all();
    return rows.map(logEntryRowToDomain);
  }

  // -------------------------------------------------------------------------
  // deleteBefore
  // -------------------------------------------------------------------------

  /**
   * deleteBefore removes all log entries with created_at strictly before the
   * cutoff date. Returns the number of rows deleted.
   */
  async deleteBefore(before: Date): Promise<number> {
    const result = this.writer
      .delete(log_entries)
      .where(lt(log_entries.created_at, before))
      .run();
    return result.changes;
  }

  // -------------------------------------------------------------------------
  // count
  // -------------------------------------------------------------------------

  /**
   * count returns the total number of log entries in the table.
   */
  async count(): Promise<number> {
    const result = this.reader
      .select({ count: sql<number>`count(*)` })
      .from(log_entries)
      .get();
    return result?.count ?? 0;
  }

  // -------------------------------------------------------------------------
  // getOldest
  // -------------------------------------------------------------------------

  /**
   * getOldest returns the N oldest log entries, ordered by created_at ASC.
   */
  async getOldest(limit: number): Promise<LogEntry[]> {
    const rows = this.reader
      .select()
      .from(log_entries)
      .orderBy(asc(log_entries.created_at))
      .limit(limit)
      .all();
    return rows.map(logEntryRowToDomain);
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * newLogStore creates a LogStoreImpl backed by the given DB.
 *
 * For file-based databases (production), pass db.reader as the second
 * argument to use the dedicated read connection for SELECT operations.
 *
 * For in-memory databases (tests), omit the reader argument — the store
 * defaults to db.writer for both reads and writes, ensuring visibility of
 * uncommitted data within the same connection.
 *
 * Example (production):
 *   const store = newLogStore(db, db.reader);
 *
 * Example (tests):
 *   const db = newInMemoryDB();
 *   const store = newLogStore(db);
 */
export function newLogStore(
  db: DB,
  reader?: BetterSQLite3Database<typeof schema>,
): LogStoreImpl {
  return new LogStoreImpl(db, reader);
}
