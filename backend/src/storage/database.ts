/**
 * Database — root-only SQLite database wrapper (INV-04).
 *
 * Wraps Drizzle ORM over better-sqlite3 with production-hardened SQLite
 * pragmas and an async write queue for serializing all mutations.
 *
 * ## SQLite Pragmas (applied on initialize)
 *
 * | Pragma              | Value       | Rationale                                          |
 * |----------------------|-------------|-----------------------------------------------------|
 * | journal_mode         | WAL         | Concurrent readers with single writer               |
 * | synchronous          | NORMAL      | Durability balance — WAL + NORMAL is crash-safe     |
 * | busy_timeout         | 5000        | Wait up to 5 s for lock before SQLITE_BUSY          |
 * | foreign_keys         | ON          | Enforce FK constraints at the engine level           |
 *
 * ## Async Write Queue
 *
 * All write operations are serialized through an in-memory FIFO queue to
 * eliminate SQLITE_BUSY errors. Reads bypass the queue (WAL snapshot
 * isolation allows concurrent reads).
 *
 * @module storage/database
 */

import BetterSqlite3 from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { InternalError } from '../domain/errors.js';
import * as schema from './schema.js';

/** High-water mark threshold for write queue backpressure. */
const QUEUE_HIGH_WATER = 10_000;
const QUEUE_WARN_THRESHOLD = 5_000;

interface WriteRequest<T> {
  fn: () => T;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  priority: 'normal' | 'low';
}

/**
 * Root-only SQLite database wrapper.
 *
 * Provides a Drizzle ORM database instance with WAL mode, serialized writes
 * via an async write queue, and lifecycle management (initialize/close).
 *
 * Constructed via `new Database(dbPath)` for file-backed databases or
 * `newInMemoryDB()` for testing. Must call `initialize()` before use.
 */
export class Database {
  private readonly dbPath: string;
  private connection: BetterSqlite3.Database | null = null;
  private db: BetterSQLite3Database<typeof schema> | null = null;
  private queue: WriteRequest<unknown>[] = [];
  private draining = false;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  async initialize(): Promise<void> {
    if (this.connection) {
      return; // Already initialized
    }

    this.connection = new BetterSqlite3(this.dbPath);

    // Apply pragmas in specified order
    this.connection.pragma('journal_mode = WAL');
    this.connection.pragma('synchronous = NORMAL');
    this.connection.pragma('busy_timeout = 5000');
    this.connection.pragma('foreign_keys = ON');

    // Create Drizzle instance with schema
    this.db = drizzle(this.connection, { schema });

    // Create tables from schema definitions
    this.createTables();
  }

  getDB(): BetterSQLite3Database<typeof schema> {
    if (!this.db) {
      throw new InternalError('Database not initialized');
    }
    return this.db;
  }

  /**
   * Returns the raw better-sqlite3 connection for direct SQL access.
   * Primarily used by tests to verify pragmas.
   */
  getConnection(): BetterSqlite3.Database {
    if (!this.connection) {
      throw new InternalError('Database not initialized');
    }
    return this.connection;
  }

  async enqueueWrite<T>(fn: () => T, priority: 'normal' | 'low' = 'normal'): Promise<T> {
    if (this.closed) {
      throw new InternalError('Database is closed');
    }

    // Backpressure: drop low-priority writes when queue is over high-water mark
    if (this.queue.length >= QUEUE_HIGH_WATER && priority === 'low') {
      throw new InternalError('Write queue full — low-priority write dropped');
    }

    if (this.queue.length >= QUEUE_WARN_THRESHOLD && this.queue.length % 1000 === 0) {
      console.warn(`Database write queue at ${this.queue.length}/${QUEUE_HIGH_WATER}`);
    }

    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        fn: fn as () => unknown,
        resolve: resolve as (value: unknown) => void,
        reject,
        priority,
      });

      if (!this.draining) {
        this.draining = true;
        queueMicrotask(() => this.drain());
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed && this.closePromise) {
      return this.closePromise;
    }

    if (this.closed && !this.connection) {
      return; // Already fully closed
    }

    this.closed = true;

    this.closePromise = new Promise<void>((resolve) => {
      const finish = () => {
        if (this.connection) {
          this.connection.close();
          this.connection = null;
          this.db = null;
        }
        resolve();
      };

      // If queue is empty and not draining, close immediately
      if (this.queue.length === 0 && !this.draining) {
        finish();
      } else {
        // Wait for drain to complete, then close
        const checkDrain = () => {
          if (this.queue.length === 0 && !this.draining) {
            finish();
          } else {
            queueMicrotask(checkDrain);
          }
        };
        queueMicrotask(checkDrain);
      }
    });

    return this.closePromise;
  }

  getPath(): string {
    return this.dbPath;
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const request = this.queue.shift()!;
      try {
        const result = request.fn();
        request.resolve(result);
      } catch (error) {
        request.reject(error);
      }
    }
    this.draining = false;
  }

  /* eslint-disable @typescript-eslint/no-unused-vars */
  private createTables(): void {
    if (!this.connection) return;

    // Using better-sqlite3's exec for DDL (not shell exec — this is a SQL method)
    const ddl = `
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL DEFAULT '',
        team_slug TEXT NOT NULL DEFAULT '',
        agent_aid TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        prompt TEXT NOT NULL DEFAULT '',
        result TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        blocked_by TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        CHECK (status IN ('pending','active','completed','failed','escalated','cancelled'))
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_parent_id ON tasks(parent_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_team_slug ON tasks(team_slug);
      CREATE INDEX IF NOT EXISTS idx_tasks_agent_aid ON tasks(agent_aid);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_jid TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL DEFAULT '',
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat_jid ON messages(chat_jid);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);

      CREATE TABLE IF NOT EXISTS chat_sessions (
        chat_jid TEXT PRIMARY KEY,
        channel_type TEXT NOT NULL DEFAULT '',
        last_timestamp INTEGER NOT NULL,
        last_agent_timestamp INTEGER NOT NULL,
        session_id TEXT NOT NULL DEFAULT '',
        agent_aid TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS log_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level INTEGER NOT NULL DEFAULT 0,
        event_type TEXT NOT NULL DEFAULT '',
        component TEXT NOT NULL DEFAULT '',
        action TEXT NOT NULL DEFAULT '',
        message TEXT NOT NULL DEFAULT '',
        params TEXT NOT NULL DEFAULT '',
        team_slug TEXT NOT NULL DEFAULT '',
        task_id TEXT NOT NULL DEFAULT '',
        agent_aid TEXT NOT NULL DEFAULT '',
        request_id TEXT NOT NULL DEFAULT '',
        correlation_id TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        duration_ms INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_log_entries_level ON log_entries(level);
      CREATE INDEX IF NOT EXISTS idx_log_entries_event_type ON log_entries(event_type);
      CREATE INDEX IF NOT EXISTS idx_log_entries_component ON log_entries(component);
      CREATE INDEX IF NOT EXISTS idx_log_entries_team_slug ON log_entries(team_slug);
      CREATE INDEX IF NOT EXISTS idx_log_entries_task_id ON log_entries(task_id);
      CREATE INDEX IF NOT EXISTS idx_log_entries_agent_aid ON log_entries(agent_aid);
      CREATE INDEX IF NOT EXISTS idx_log_entries_request_id ON log_entries(request_id);
      CREATE INDEX IF NOT EXISTS idx_log_entries_correlation_id ON log_entries(correlation_id);
      CREATE INDEX IF NOT EXISTS idx_log_entries_created_at ON log_entries(created_at);

      CREATE TABLE IF NOT EXISTS task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        log_entry_id INTEGER NOT NULL REFERENCES log_entries(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL,
        from_status TEXT NOT NULL DEFAULT '',
        to_status TEXT NOT NULL,
        agent_aid TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_events_task_id ON task_events(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_events_log_entry_id ON task_events(log_entry_id);
      CREATE INDEX IF NOT EXISTS idx_task_events_created_at ON task_events(created_at);

      CREATE TABLE IF NOT EXISTS tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        log_entry_id INTEGER NOT NULL REFERENCES log_entries(id) ON DELETE CASCADE,
        tool_use_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        agent_aid TEXT NOT NULL,
        team_slug TEXT NOT NULL DEFAULT '',
        task_id TEXT NOT NULL DEFAULT '',
        params TEXT NOT NULL DEFAULT '',
        result_summary TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        duration_ms INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tool_calls_tool_name ON tool_calls(tool_name);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_agent_aid ON tool_calls(agent_aid);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_task_id ON tool_calls(task_id);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_log_entry_id ON tool_calls(log_entry_id);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_created_at ON tool_calls(created_at);

      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        log_entry_id INTEGER NOT NULL REFERENCES log_entries(id) ON DELETE CASCADE,
        decision_type TEXT NOT NULL,
        agent_aid TEXT NOT NULL,
        task_id TEXT NOT NULL DEFAULT '',
        chosen_action TEXT NOT NULL DEFAULT '',
        alternatives TEXT NOT NULL DEFAULT '',
        reasoning TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_decisions_decision_type ON decisions(decision_type);
      CREATE INDEX IF NOT EXISTS idx_decisions_agent_aid ON decisions(agent_aid);
      CREATE INDEX IF NOT EXISTS idx_decisions_log_entry_id ON decisions(log_entry_id);
      CREATE INDEX IF NOT EXISTS idx_decisions_created_at ON decisions(created_at);

      CREATE TABLE IF NOT EXISTS agent_memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_aid TEXT NOT NULL,
        team_slug TEXT NOT NULL,
        content TEXT NOT NULL,
        memory_type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        deleted_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_memories_agent_aid ON agent_memories(agent_aid);
      CREATE INDEX IF NOT EXISTS idx_memories_team_slug ON agent_memories(team_slug);

      CREATE TABLE IF NOT EXISTS integrations (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        name TEXT NOT NULL,
        config_path TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'proposed',
        created_at INTEGER NOT NULL,
        CHECK (status IN ('proposed','validated','tested','approved','active','failed','rolled_back'))
      );
      CREATE INDEX IF NOT EXISTS idx_integrations_team_id ON integrations(team_id);

      CREATE TABLE IF NOT EXISTS credentials (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        encrypted_value TEXT NOT NULL,
        team_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_credentials_team_id ON credentials(team_id);
      CREATE INDEX IF NOT EXISTS idx_credentials_name ON credentials(name);
    `;

    this.connection.exec(ddl);
  }
  /* eslint-enable @typescript-eslint/no-unused-vars */
}

/**
 * Creates an in-memory Database instance for testing.
 *
 * Uses `:memory:` as the database path so no file I/O occurs. The returned
 * instance still requires `initialize()` before use — pragmas and migrations
 * are applied identically to file-backed databases (except WAL mode, which
 * is a no-op for in-memory databases).
 */
export function newInMemoryDB(): Database {
  return new Database(':memory:');
}
