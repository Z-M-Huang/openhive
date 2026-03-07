/**
 * OpenHive Backend - Database Connection Layer
 *
 * IMPORTANT: better-sqlite3 uses a synchronous C-binding API.
 * Every database call (query, insert, transaction) BLOCKS the Node.js event
 * loop for its duration. This is intentional and acceptable because:
 *   1. OpenHive is a single-user system with low query volume.
 *   2. Typical queries complete in <1ms (often <0.1ms for indexed lookups).
 *   3. Batch inserts (log writes) MUST use prepared statements inside a single
 *      transaction — better-sqlite3 transactions run at ~100K inserts/sec.
 *      Limit batch sizes to 500 rows per transaction (~5ms blocking max).
 *   4. Recursive CTEs (GetSubtree) are bounded by maxDepth=100 and shallow
 *      task trees in practice — blocking time is negligible.
 *   5. If future profiling shows event loop stalls, the escape hatch is
 *      worker_threads — do NOT implement this speculatively.
 *
 * Design:
 *   - Dual connections: writer (serialized writes) + reader (concurrent reads)
 *   - WAL mode for concurrent read/write
 *   - busy_timeout=5000ms, synchronous=NORMAL pragmas
 *   - Schema migration on init (CREATE TABLE IF NOT EXISTS)
 *   - withTransaction() for write serialization with automatic rollback
 */

import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

// ---------------------------------------------------------------------------
// Schema DDL
// ---------------------------------------------------------------------------

/**
 * Raw SQL DDL for all four tables.
 * These statements match the Drizzle schema definitions in schema.ts exactly.
 * Using CREATE TABLE IF NOT EXISTS avoids dependency on external migration
 * files while still being idempotent on repeated initialization.
 *
 * Column types mirror the Drizzle definitions:
 *   - text  → TEXT
 *   - integer (regular) → INTEGER
 *   - integer (timestamp_ms) → INTEGER  (Drizzle stores Date as Unix ms)
 */
const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT    NOT NULL PRIMARY KEY,
  parent_id    TEXT    NOT NULL DEFAULT '',
  team_slug    TEXT    NOT NULL DEFAULT '',
  agent_aid    TEXT    NOT NULL DEFAULT '',
  jid          TEXT    NOT NULL DEFAULT '',
  status       INTEGER NOT NULL DEFAULT 0,
  prompt       TEXT    NOT NULL DEFAULT '',
  result       TEXT    NOT NULL DEFAULT '',
  error        TEXT    NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_parent_id  ON tasks (parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_team_slug  ON tasks (team_slug);
CREATE INDEX IF NOT EXISTS idx_tasks_agent_aid  ON tasks (agent_aid);
CREATE INDEX IF NOT EXISTS idx_tasks_jid        ON tasks (jid);
CREATE INDEX IF NOT EXISTS idx_tasks_status     ON tasks (status);

CREATE TABLE IF NOT EXISTS messages (
  id        TEXT    NOT NULL PRIMARY KEY,
  chat_jid  TEXT    NOT NULL DEFAULT '',
  role      TEXT    NOT NULL DEFAULT '',
  content   TEXT    NOT NULL DEFAULT '',
  timestamp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_jid  ON messages (chat_jid);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages (timestamp);

CREATE TABLE IF NOT EXISTS log_entries (
  id          INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  level       INTEGER NOT NULL DEFAULT 0,
  component   TEXT    NOT NULL DEFAULT '',
  action      TEXT    NOT NULL DEFAULT '',
  message     TEXT    NOT NULL DEFAULT '',
  params      TEXT    NOT NULL DEFAULT '',
  team_name   TEXT    NOT NULL DEFAULT '',
  task_id     TEXT    NOT NULL DEFAULT '',
  agent_name  TEXT    NOT NULL DEFAULT '',
  request_id  TEXT    NOT NULL DEFAULT '',
  error       TEXT    NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_log_entries_level      ON log_entries (level);
CREATE INDEX IF NOT EXISTS idx_log_entries_component  ON log_entries (component);
CREATE INDEX IF NOT EXISTS idx_log_entries_team_name  ON log_entries (team_name);
CREATE INDEX IF NOT EXISTS idx_log_entries_task_id    ON log_entries (task_id);
CREATE INDEX IF NOT EXISTS idx_log_entries_request_id ON log_entries (request_id);
CREATE INDEX IF NOT EXISTS idx_log_entries_created_at ON log_entries (created_at);

CREATE TABLE IF NOT EXISTS chat_sessions (
  chat_jid             TEXT    NOT NULL PRIMARY KEY,
  channel_type         TEXT    NOT NULL DEFAULT '',
  last_timestamp       INTEGER NOT NULL,
  last_agent_timestamp INTEGER NOT NULL,
  session_id           TEXT    NOT NULL DEFAULT '',
  agent_aid            TEXT    NOT NULL DEFAULT ''
);
`;

// ---------------------------------------------------------------------------
// DB class
// ---------------------------------------------------------------------------

/**
 * DB wraps two better-sqlite3 Database instances with Drizzle ORM.
 *
 * Writer: single connection, used for all INSERT/UPDATE/DELETE operations.
 *   SQLite's synchronous API naturally serializes writes — no async locking
 *   is needed.
 *
 * Reader: separate connection, used for SELECT operations.
 *   WAL mode allows the reader to run concurrently with the writer without
 *   blocking. A single synchronous reader connection is sufficient.
 *
 * Both connections are wrapped by Drizzle ORM for type-safe query building.
 */
export class DB {
  /** Drizzle ORM instance for write operations (INSERT/UPDATE/DELETE). */
  readonly writer: BetterSQLite3Database<typeof schema>;

  /** Drizzle ORM instance for read operations (SELECT). */
  readonly reader: BetterSQLite3Database<typeof schema>;

  /** Raw better-sqlite3 writer connection (used internally for transactions). */
  readonly _writerConn: Database.Database;

  /** Raw better-sqlite3 reader connection (used internally for close). */
  readonly _readerConn: Database.Database;

  constructor(writerConn: Database.Database, readerConn: Database.Database) {
    this._writerConn = writerConn;
    this._readerConn = readerConn;
    this.writer = drizzle(writerConn, { schema });
    this.reader = drizzle(readerConn, { schema });
  }

  /**
   * withTransaction runs fn inside a SQLite transaction on the writer
   * connection. If fn throws, the transaction is automatically rolled back.
   * If fn returns normally, the transaction is committed.
   *
   * NOTE: better-sqlite3 transactions are synchronous and extremely fast
   * (~100K inserts/sec). Keep batch sizes at or below 500 rows to limit
   * blocking to ~5ms per call.
   *
   * @param fn - Function to run inside the transaction. Receives the Drizzle
   *             writer instance for query building.
   * @returns The return value of fn.
   */
  withTransaction<T>(fn: (tx: BetterSQLite3Database<typeof schema>) => T): T {
    // better-sqlite3's transaction() wrapper handles BEGIN / COMMIT / ROLLBACK
    // synchronously. We wrap fn to pass the Drizzle writer instance.
    const txFn = this._writerConn.transaction(() => fn(this.writer));
    return txFn();
  }

  /**
   * close cleanly closes both writer and reader connections.
   * After close(), this DB instance must not be used.
   */
  close(): void {
    this._writerConn.close();
    this._readerConn.close();
  }
}

// ---------------------------------------------------------------------------
// Pragma helpers
// ---------------------------------------------------------------------------

/**
 * setPragmas applies the standard SQLite pragmas to a connection.
 *
 * - journal_mode=WAL: enables Write-Ahead Logging for concurrent read/write
 * - busy_timeout=5000: wait up to 5s when the database is locked
 * - synchronous=NORMAL: balance between safety and performance
 */
function setPragmas(conn: Database.Database): void {
  conn.pragma('journal_mode=WAL');
  conn.pragma('busy_timeout=5000');
  conn.pragma('synchronous=NORMAL');
}

/**
 * runSchemaMigration runs all CREATE TABLE IF NOT EXISTS statements on the
 * writer connection. This is idempotent and safe to call on every startup.
 */
function runSchemaMigration(conn: Database.Database): void {
  conn.exec(SCHEMA_DDL);
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

/**
 * newDB creates a file-based DB at the given path.
 *
 * The writer connection opens with default options (read-write-create).
 * The reader connection opens in readonly mode, which is safe with WAL since
 * SQLite WAL readers never block writers and vice versa.
 *
 * Schema migration (CREATE TABLE IF NOT EXISTS) is run on the writer
 * connection before returning, so the database is always ready to use.
 *
 * @param path - Filesystem path to the SQLite database file.
 * @returns A fully initialized DB instance.
 *
 * Example:
 *   const db = newDB('/data/.run/openhive.db');
 */
export function newDB(path: string): DB {
  const writerConn = new Database(path);
  setPragmas(writerConn);
  runSchemaMigration(writerConn);

  // Open a separate read-only connection for concurrent reads.
  const readerConn = new Database(path, { readonly: true });
  setPragmas(readerConn);

  return new DB(writerConn, readerConn);
}

/**
 * newInMemoryDB creates an in-memory SQLite database for testing.
 *
 * Uses better-sqlite3's ':memory:' special path. The reader connection is
 * also in-memory (separate instance) to satisfy the DB constructor's dual
 * connection contract while keeping tests isolated and fast.
 *
 * In tests, reads are typically performed via the writer connection since
 * the two in-memory databases cannot share data. Tests should use
 * db.writer for both reads and writes to see consistent results.
 *
 * @returns A fully initialized in-memory DB instance.
 *
 * Example:
 *   const db = newInMemoryDB();
 *   // Use db in tests — no file created, cleaned up on close()
 */
export function newInMemoryDB(): DB {
  const writerConn = new Database(':memory:');
  setPragmas(writerConn);
  runSchemaMigration(writerConn);

  // Separate in-memory reader — cannot share data with writer,
  // but satisfies the type contract and allows testing close() behavior.
  const readerConn = new Database(':memory:');
  setPragmas(readerConn);

  return new DB(writerConn, readerConn);
}
