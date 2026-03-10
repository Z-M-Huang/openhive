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
 * Raw SQL DDL for all seven tables.
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
  id                 TEXT    NOT NULL PRIMARY KEY,
  parent_id          TEXT    NOT NULL DEFAULT '',
  team_slug          TEXT    NOT NULL DEFAULT '',
  agent_aid          TEXT    NOT NULL DEFAULT '',
  jid                TEXT    NOT NULL DEFAULT '',
  status             INTEGER NOT NULL DEFAULT 0,
  prompt             TEXT    NOT NULL DEFAULT '',
  result             TEXT    NOT NULL DEFAULT '',
  error              TEXT    NOT NULL DEFAULT '',
  blocked_by_task_id TEXT    NOT NULL DEFAULT '',
  blocked_by         TEXT    NOT NULL DEFAULT '[]',
  priority           INTEGER NOT NULL DEFAULT 0,
  retry_count        INTEGER NOT NULL DEFAULT 0,
  max_retries        INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  completed_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_parent_id          ON tasks (parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_team_slug          ON tasks (team_slug);
CREATE INDEX IF NOT EXISTS idx_tasks_agent_aid          ON tasks (agent_aid);
CREATE INDEX IF NOT EXISTS idx_tasks_jid                ON tasks (jid);
CREATE INDEX IF NOT EXISTS idx_tasks_status             ON tasks (status);
CREATE INDEX IF NOT EXISTS idx_tasks_priority           ON tasks (priority);

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

CREATE TABLE IF NOT EXISTS escalations (
  id               TEXT    NOT NULL PRIMARY KEY,
  correlation_id   TEXT    NOT NULL DEFAULT '',
  task_id          TEXT    NOT NULL DEFAULT '',
  from_aid         TEXT    NOT NULL DEFAULT '',
  to_aid           TEXT    NOT NULL DEFAULT '',
  source_team      TEXT    NOT NULL DEFAULT '',
  destination_team TEXT    NOT NULL DEFAULT '',
  escalation_level INTEGER NOT NULL DEFAULT 1,
  reason           TEXT    NOT NULL DEFAULT '',
  context          TEXT    NOT NULL DEFAULT '',
  status           INTEGER NOT NULL DEFAULT 0,
  resolution       TEXT    NOT NULL DEFAULT '',
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  resolved_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_escalations_correlation_id ON escalations (correlation_id);
CREATE INDEX IF NOT EXISTS idx_escalations_task_id        ON escalations (task_id);
CREATE INDEX IF NOT EXISTS idx_escalations_from_aid       ON escalations (from_aid);
CREATE INDEX IF NOT EXISTS idx_escalations_to_aid         ON escalations (to_aid);
CREATE INDEX IF NOT EXISTS idx_escalations_status         ON escalations (status);
CREATE INDEX IF NOT EXISTS idx_escalations_created_id     ON escalations (created_at);

CREATE TABLE IF NOT EXISTS agent_memories (
  id         TEXT    NOT NULL PRIMARY KEY,
  agent_aid  TEXT    NOT NULL DEFAULT '',
  key        TEXT    NOT NULL DEFAULT '',
  value      TEXT    NOT NULL DEFAULT '',
  metadata   TEXT    NOT NULL DEFAULT '',
  team_slug  TEXT    NOT NULL DEFAULT '',
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_memories_agent_aid  ON agent_memories (agent_aid);
CREATE INDEX IF NOT EXISTS idx_agent_memories_key        ON agent_memories (key);
CREATE INDEX IF NOT EXISTS idx_agent_memories_agent_key  ON agent_memories (agent_aid, key);
CREATE INDEX IF NOT EXISTS idx_agent_memories_team_slug  ON agent_memories (team_slug);

CREATE TABLE IF NOT EXISTS triggers (
  id           TEXT    NOT NULL PRIMARY KEY,
  name         TEXT    NOT NULL DEFAULT '',
  team_slug    TEXT    NOT NULL DEFAULT '',
  agent_aid    TEXT    NOT NULL DEFAULT '',
  schedule     TEXT    NOT NULL DEFAULT '',
  prompt       TEXT    NOT NULL DEFAULT '',
  enabled      INTEGER NOT NULL DEFAULT 1,
  type         TEXT    NOT NULL DEFAULT 'cron',
  webhook_path TEXT    NOT NULL DEFAULT '',
  last_run_at  INTEGER,
  next_run_at  INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_triggers_team_slug    ON triggers (team_slug);
CREATE INDEX IF NOT EXISTS idx_triggers_agent_aid    ON triggers (agent_aid);
CREATE INDEX IF NOT EXISTS idx_triggers_enabled      ON triggers (enabled);
CREATE INDEX IF NOT EXISTS idx_triggers_next_run_at  ON triggers (next_run_at);
CREATE INDEX IF NOT EXISTS idx_triggers_webhook_path ON triggers (webhook_path) WHERE webhook_path != '';
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
 * writer connection, then applies incremental ALTER TABLE migrations for
 * columns added after the initial schema. This is idempotent and safe to
 * call on every startup.
 */
function runSchemaMigration(conn: Database.Database): void {
  conn.exec(SCHEMA_DDL);
  runIncrementalMigrations(conn);
}

/**
 * Applies incremental schema migrations (ALTER TABLE) for columns added
 * after the initial schema. Each migration checks if the column already
 * exists before attempting to add it, making the function idempotent.
 *
 * Migrations:
 *   1. tasks.blocked_by_task_id — added for task dependency blocking
 *   2. tasks.blocked_by, priority, retry_count, max_retries — task DAG system
 *   3. agent_memories.team_slug, deleted_at — team scoping + soft delete
 */
function runIncrementalMigrations(conn: Database.Database): void {
  const columns = conn.prepare("PRAGMA table_info('tasks')").all() as Array<{
    name: string;
  }>;
  const columnNames = new Set(columns.map((c) => c.name));

  // Migration 1: blocked_by_task_id (legacy single-task dependency)
  if (!columnNames.has('blocked_by_task_id')) {
    conn.exec(
      "ALTER TABLE tasks ADD COLUMN blocked_by_task_id TEXT NOT NULL DEFAULT ''",
    );
  }
  // Always ensure index exists — handles both fresh DBs (column in SCHEMA_DDL but
  // index deferred here) and migrations (column just added above).
  conn.exec(
    'CREATE INDEX IF NOT EXISTS idx_tasks_blocked_by_task_id ON tasks (blocked_by_task_id)',
  );

  // Migration 2: Task DAG columns — blocked_by (JSON array), priority,
  // retry_count, max_retries
  if (!columnNames.has('blocked_by')) {
    conn.exec(
      "ALTER TABLE tasks ADD COLUMN blocked_by TEXT NOT NULL DEFAULT '[]'",
    );
    conn.exec(
      'ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0',
    );
    conn.exec(
      'ALTER TABLE tasks ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0',
    );
    conn.exec(
      'ALTER TABLE tasks ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 0',
    );

    // Migrate existing blocked_by_task_id data into the new blocked_by JSON
    // array. Only rows with a non-empty blocked_by_task_id get migrated.
    conn.exec(
      "UPDATE tasks SET blocked_by = json_array(blocked_by_task_id) WHERE blocked_by_task_id != ''",
    );
  }
  // Always ensure priority index exists.
  conn.exec(
    'CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks (priority)',
  );

  // Migration 3: agent_memories.team_slug and deleted_at — team scoping + soft delete
  const memColumns = conn
    .prepare("PRAGMA table_info('agent_memories')")
    .all() as Array<{ name: string }>;
  const memColumnNames = new Set(memColumns.map((c) => c.name));

  if (!memColumnNames.has('team_slug')) {
    conn.exec(
      "ALTER TABLE agent_memories ADD COLUMN team_slug TEXT NOT NULL DEFAULT ''",
    );
    conn.exec(
      'ALTER TABLE agent_memories ADD COLUMN deleted_at INTEGER',
    );
  }
  // Always ensure team_slug index exists.
  conn.exec(
    'CREATE INDEX IF NOT EXISTS idx_agent_memories_team_slug ON agent_memories (team_slug)',
  );

  // Migration 4: triggers.type and webhook_path — webhook trigger support
  const trigColumns = conn
    .prepare("PRAGMA table_info('triggers')")
    .all() as Array<{ name: string }>;
  const trigColumnNames = new Set(trigColumns.map((c) => c.name));

  if (!trigColumnNames.has('type')) {
    conn.exec(
      "ALTER TABLE triggers ADD COLUMN type TEXT NOT NULL DEFAULT 'cron'",
    );
    conn.exec(
      "ALTER TABLE triggers ADD COLUMN webhook_path TEXT NOT NULL DEFAULT ''",
    );
  }
  // Always ensure webhook_path partial index exists.
  conn.exec(
    "CREATE INDEX IF NOT EXISTS idx_triggers_webhook_path ON triggers (webhook_path) WHERE webhook_path != ''",
  );
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
