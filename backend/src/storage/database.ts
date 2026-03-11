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
 * ## Async Write Queue (~50 lines at implementation time)
 *
 * All write operations (INSERT, UPDATE, DELETE, transactions) are serialized
 * through an in-memory FIFO queue to eliminate SQLITE_BUSY errors that arise
 * when multiple components issue concurrent writes against the same WAL-mode
 * database. The pattern works as follows:
 *
 * 1. Every write call wraps the operation in a `WriteRequest<T>` containing:
 *    - `fn`: The `() => T` synchronous callback that performs the actual
 *      better-sqlite3 operation (which is synchronous under the hood).
 *    - `resolve` / `reject`: Promise settlement callbacks returned to the caller.
 *
 * 2. `WriteRequest` objects are pushed onto a queue (`WriteRequest[]`).
 *
 * 3. A single `drain()` loop processes requests one at a time:
 *    - Dequeues the next request.
 *    - Calls `request.fn()` inside a try/catch.
 *    - Settles the caller's promise via `resolve(result)` or `reject(error)`.
 *    - Continues until the queue is empty, then marks itself idle.
 *
 * 4. When a new request arrives and the drain loop is idle, the loop restarts
 *    via `queueMicrotask(drain)` (zero-cost when idle, no timers).
 *
 * 5. `close()` drains remaining writes before closing the underlying connection,
 *    rejecting any writes enqueued after close is initiated.
 *
 * This guarantees that at most one write executes at any time, while reads
 * (which go through WAL snapshot isolation) remain fully concurrent and bypass
 * the queue entirely. The queue is ~50 lines of code with no external
 * dependencies beyond the built-in Promise/queueMicrotask APIs.
 *
 * @module storage/database
 */

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

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

  /**
   * Creates a new Database instance.
   *
   * Does NOT open the connection — call `initialize()` to open the database,
   * apply pragmas (WAL, synchronous=NORMAL, busy_timeout=5000, foreign_keys=ON),
   * and start the async write queue.
   *
   * @param dbPath - Absolute path to the SQLite database file.
   */
  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /**
   * Opens the SQLite connection, applies pragmas, runs migrations, and starts
   * the async write queue.
   *
   * Pragma application order:
   * 1. `PRAGMA journal_mode = WAL`
   * 2. `PRAGMA synchronous = NORMAL`
   * 3. `PRAGMA busy_timeout = 5000`
   * 4. `PRAGMA foreign_keys = ON`
   *
   * After pragmas, runs Drizzle migrations from `storage/migrations/`.
   * Finally, initializes the write queue drain loop.
   *
   * @throws Error if the database file cannot be opened or migrations fail.
   */
  async initialize(): Promise<void> {
    throw new Error('Not implemented');
  }

  /**
   * Returns the Drizzle ORM database instance for read queries.
   *
   * Reads go directly through Drizzle (WAL snapshot isolation permits
   * concurrent reads). Writes must go through the write queue methods
   * exposed by the store layer.
   *
   * @throws Error if the database has not been initialized.
   */
  getDB(): BetterSQLite3Database {
    throw new Error('Not implemented');
  }

  /**
   * Enqueues a synchronous write operation on the async write queue.
   *
   * The caller receives a Promise that settles once the write has been
   * processed by the drain loop. All writes are serialized — at most one
   * write executes at any given time.
   *
   * @param fn - Synchronous callback performing the better-sqlite3 write.
   * @returns Promise resolving to the callback's return value.
   * @throws Error if the database is closed or closing.
   */
  async enqueueWrite<T>(_fn: () => T): Promise<T> {
    throw new Error('Not implemented');
  }

  /**
   * Drains the write queue and closes the underlying better-sqlite3 connection.
   *
   * 1. Marks the database as closing (new enqueueWrite calls reject).
   * 2. Waits for the write queue to fully drain.
   * 3. Closes the better-sqlite3 connection.
   *
   * Safe to call multiple times (idempotent).
   */
  async close(): Promise<void> {
    throw new Error('Not implemented');
  }

  /**
   * Returns the file path of the database (or `:memory:` for in-memory).
   */
  getPath(): string {
    return this.dbPath;
  }
}

/**
 * Creates an in-memory Database instance for testing.
 *
 * Uses `:memory:` as the database path so no file I/O occurs. The returned
 * instance still requires `initialize()` before use — pragmas and migrations
 * are applied identically to file-backed databases (except WAL mode, which
 * is a no-op for in-memory databases).
 *
 * @returns A new Database instance backed by an in-memory SQLite database.
 */
export function newInMemoryDB(): Database {
  return new Database(':memory:');
}
