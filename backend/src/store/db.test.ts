/**
 * Tests for backend/src/store/db.ts
 *
 * Verifies the database connection layer:
 *   1. newDB creates a file-based database with WAL mode enabled
 *   2. newInMemoryDB creates an in-memory database (no file created)
 *   3. All four tables are created on initialization
 *   4. withTransaction commits on success
 *   5. withTransaction rolls back on error
 *   6. close() cleanly closes connections
 *   7. WAL mode is verified via PRAGMA query
 *
 * Note: better-sqlite3 is synchronous — all DB operations block the event
 * loop. Tests run synchronously without await, which is correct and expected.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { newDB, newInMemoryDB, DB } from './db.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Lists table names in a SQLite database using the sqlite_master table.
 */
function getTableNames(conn: Database.Database): string[] {
  const rows = conn
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/**
 * Returns the journal_mode pragma value for a connection.
 */
function getJournalMode(conn: Database.Database): string {
  const result = conn.pragma('journal_mode') as Array<{ journal_mode: string }>;
  return result[0].journal_mode;
}

// ---------------------------------------------------------------------------
// newInMemoryDB
// ---------------------------------------------------------------------------

describe('newInMemoryDB', () => {
  let db: DB;

  afterEach(() => {
    // Close the database after each test to release connections.
    // Guard against already-closed connections (test for close() does this
    // explicitly and would throw on a second close).
    try {
      db.close();
    } catch {
      // Already closed — ignore.
    }
  });

  it('creates an in-memory database (no file on disk)', () => {
    db = newInMemoryDB();
    // better-sqlite3 in-memory databases have 'memory' property set to true.
    expect(db._writerConn.memory).toBe(true);
    expect(db._readerConn.memory).toBe(true);
  });

  it('exposes writer and reader Drizzle ORM instances', () => {
    db = newInMemoryDB();
    expect(db.writer).toBeDefined();
    expect(db.reader).toBeDefined();
    // Drizzle instances are not null and have the query property.
    expect(db.writer.query).toBeDefined();
    expect(db.reader.query).toBeDefined();
  });

  it('creates all four tables on initialization', () => {
    db = newInMemoryDB();
    const tables = getTableNames(db._writerConn);
    // SQLite internal tables (sqlite_sequence for autoincrement) may appear
    // after the first insert, but the four schema tables must be present.
    expect(tables).toContain('tasks');
    expect(tables).toContain('messages');
    expect(tables).toContain('log_entries');
    expect(tables).toContain('chat_sessions');
  });

  it('enables WAL mode on the writer connection', () => {
    db = newInMemoryDB();
    // In-memory SQLite does not support WAL and silently falls back to
    // 'memory' journal mode. This is expected and documented behavior.
    // We assert the journal_mode is one of the valid modes (not an error).
    const mode = getJournalMode(db._writerConn);
    expect(['wal', 'memory']).toContain(mode);
  });
});

// ---------------------------------------------------------------------------
// newDB (file-based)
// ---------------------------------------------------------------------------

describe('newDB', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: DB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'openhive-db-test-'));
    dbPath = join(tmpDir, 'test.db');
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // Already closed.
    }
    // Remove temporary directory and all files (db file + WAL shm).
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a database file at the given path', () => {
    db = newDB(dbPath);
    expect(existsSync(dbPath)).toBe(true);
  });

  it('creates all four tables on initialization', () => {
    db = newDB(dbPath);
    const tables = getTableNames(db._writerConn);
    expect(tables).toContain('tasks');
    expect(tables).toContain('messages');
    expect(tables).toContain('log_entries');
    expect(tables).toContain('chat_sessions');
  });

  it('enables WAL mode on the writer connection (verified via PRAGMA)', () => {
    db = newDB(dbPath);
    const mode = getJournalMode(db._writerConn);
    expect(mode).toBe('wal');
  });

  it('sets busy_timeout=5000 on the writer connection', () => {
    db = newDB(dbPath);
    const result = db._writerConn.pragma('busy_timeout') as Array<{ timeout: number }>;
    expect(result[0].timeout).toBe(5000);
  });

  it('sets synchronous=NORMAL on the writer connection', () => {
    db = newDB(dbPath);
    // SQLite returns synchronous as a number: 0=OFF 1=NORMAL 2=FULL 3=EXTRA
    const result = db._writerConn.pragma('synchronous') as Array<{ synchronous: number }>;
    expect(result[0].synchronous).toBe(1); // NORMAL
  });

  it('is idempotent — calling newDB twice on same path does not fail', () => {
    db = newDB(dbPath);
    db.close();
    // Second open must not throw (CREATE TABLE IF NOT EXISTS is idempotent).
    db = newDB(dbPath);
    expect(existsSync(dbPath)).toBe(true);
  });

  it('opens reader in readonly mode', () => {
    db = newDB(dbPath);
    expect(db._readerConn.readonly).toBe(true);
    expect(db._writerConn.readonly).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// withTransaction
// ---------------------------------------------------------------------------

describe('withTransaction', () => {
  let db: DB;

  beforeEach(() => {
    db = newInMemoryDB();
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // Already closed.
    }
  });

  it('commits the transaction on success and data is readable after commit', () => {
    const now = Date.now();

    // Use raw SQL inside the transaction to avoid depending on Drizzle insert
    // API details. We are testing the transaction commit/rollback mechanism.
    db.withTransaction((_tx) => {
      db._writerConn
        .prepare(
          `INSERT INTO tasks (id, parent_id, team_slug, agent_aid, jid, status,
                              prompt, result, error, created_at, updated_at)
           VALUES ('task-1', '', 'main', 'aid-123', 'jid-1', 0,
                   'test prompt', '', '', ?, ?)`,
        )
        .run(now, now);
    });

    // Verify the row was committed by reading directly from the writer.
    const rows = db._writerConn
      .prepare('SELECT id FROM tasks WHERE id = ?')
      .all('task-1') as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('task-1');
  });

  it('rolls back the transaction on error', () => {
    const now = Date.now();

    // Insert a stable row successfully first (outside the failing transaction).
    db.withTransaction((_tx) => {
      db._writerConn
        .prepare(
          `INSERT INTO tasks (id, parent_id, team_slug, agent_aid, jid, status,
                              prompt, result, error, created_at, updated_at)
           VALUES ('task-stable', '', 'main', 'aid-abc', 'jid-stable', 0,
                   'stable', '', '', ?, ?)`,
        )
        .run(now, now);
    });

    // Now run a transaction that throws — the second insert must be rolled back.
    expect(() => {
      db.withTransaction((_tx) => {
        // Insert a row that would conflict (same primary key as existing row).
        db._writerConn
          .prepare(
            `INSERT INTO tasks (id, created_at, updated_at)
             VALUES ('task-conflict', ?, ?)`,
          )
          .run(now, now);

        // Throw to trigger rollback.
        throw new Error('intentional rollback');
      });
    }).toThrow('intentional rollback');

    // Verify the conflicting row was NOT committed.
    const rows = db._writerConn
      .prepare("SELECT id FROM tasks WHERE id = 'task-conflict'")
      .all() as Array<{ id: string }>;
    expect(rows).toHaveLength(0);

    // Stable row from before must still be present.
    const stableRows = db._writerConn
      .prepare("SELECT id FROM tasks WHERE id = 'task-stable'")
      .all() as Array<{ id: string }>;
    expect(stableRows).toHaveLength(1);
  });

  it('returns the value from fn on success', () => {
    const result = db.withTransaction((_tx) => {
      return 42;
    });
    expect(result).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// close()
// ---------------------------------------------------------------------------

describe('close()', () => {
  it('cleanly closes both connections', () => {
    const db = newInMemoryDB();
    expect(db._writerConn.open).toBe(true);
    expect(db._readerConn.open).toBe(true);

    db.close();

    expect(db._writerConn.open).toBe(false);
    expect(db._readerConn.open).toBe(false);
  });

  it('subsequent operations on closed connections throw', () => {
    const db = newInMemoryDB();
    db.close();

    expect(() => {
      db._writerConn.prepare('SELECT 1').all();
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// WAL mode verified via PRAGMA
// ---------------------------------------------------------------------------

describe('WAL mode via PRAGMA (file-based database)', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: DB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'openhive-wal-test-'));
    dbPath = join(tmpDir, 'wal.db');
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // Ignore.
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('journal_mode is "wal" as returned by PRAGMA journal_mode query', () => {
    db = newDB(dbPath);

    // Query WAL mode directly using PRAGMA — this is the canonical verification
    // method. The pragma returns a result set with the current journal mode.
    const result = db._writerConn.pragma('journal_mode') as Array<{ journal_mode: string }>;
    expect(result).toBeDefined();
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].journal_mode).toBe('wal');
  });

  it('WAL mode persists after reopening the database', () => {
    db = newDB(dbPath);
    db.close();

    // Reopen with plain better-sqlite3 (no pragmas) — WAL mode should persist
    // in the database file itself after the first connection set it.
    const conn = new Database(dbPath);
    const result = conn.pragma('journal_mode') as Array<{ journal_mode: string }>;
    conn.close();

    expect(result[0].journal_mode).toBe('wal');
  });
});

