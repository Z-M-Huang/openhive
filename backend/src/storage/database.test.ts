/**
 * Tests for Database class — SQLite + Drizzle ORM wrapper.
 *
 * Verifies initialization, pragmas, write queue serialization, close
 * semantics, and the newInMemoryDB() factory.
 *
 * @module storage/database.test
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Database, newInMemoryDB } from './database.js';
import { InternalError } from '../domain/errors.js';

describe('Database', () => {
  let db: Database;

  afterEach(async () => {
    if (db) {
      await db.close();
    }
  });

  describe('initialize() + getDB()', () => {
    it('returns a Drizzle instance after initialization', async () => {
      db = newInMemoryDB();
      await db.initialize();
      const drizzleDb = db.getDB();
      expect(drizzleDb).toBeDefined();
    });

    it('is idempotent — second call is a no-op', async () => {
      db = newInMemoryDB();
      await db.initialize();
      const db1 = db.getDB();
      await db.initialize();
      const db2 = db.getDB();
      expect(db1).toBe(db2);
    });
  });

  describe('getDB() before initialize()', () => {
    it('throws InternalError', () => {
      db = newInMemoryDB();
      expect(() => db.getDB()).toThrow(InternalError);
      expect(() => db.getDB()).toThrow('Database not initialized');
    });
  });

  describe('pragma verification', () => {
    it('sets foreign_keys = ON', async () => {
      db = newInMemoryDB();
      await db.initialize();
      const conn = db.getConnection();
      const fk = conn.pragma('foreign_keys', { simple: true });
      expect(fk).toBe(1);
    });

    it('sets synchronous = NORMAL (1)', async () => {
      db = newInMemoryDB();
      await db.initialize();
      const conn = db.getConnection();
      const sync = conn.pragma('synchronous', { simple: true });
      expect(sync).toBe(1); // NORMAL = 1
    });

    it('sets busy_timeout = 5000', async () => {
      db = newInMemoryDB();
      await db.initialize();
      const conn = db.getConnection();
      const timeout = conn.pragma('busy_timeout', { simple: true });
      expect(timeout).toBe(5000);
    });

    it('sets journal_mode = WAL (or memory for :memory:)', async () => {
      db = newInMemoryDB();
      await db.initialize();
      const conn = db.getConnection();
      const mode = conn.pragma('journal_mode', { simple: true });
      // In-memory databases return 'memory' for journal_mode instead of 'wal'
      expect(['wal', 'memory']).toContain(mode);
    });
  });

  describe('table creation', () => {
    it('creates all 10 tables on initialize', async () => {
      db = newInMemoryDB();
      await db.initialize();
      const conn = db.getConnection();
      const tables = conn.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      ).all() as Array<{ name: string }>;
      const names = tables.map(t => t.name);

      expect(names).toContain('tasks');
      expect(names).toContain('messages');
      expect(names).toContain('chat_sessions');
      expect(names).toContain('log_entries');
      expect(names).toContain('task_events');
      expect(names).toContain('tool_calls');
      expect(names).toContain('decisions');
      expect(names).toContain('agent_memories');
      expect(names).toContain('integrations');
      expect(names).toContain('credentials');
    });
  });

  describe('write queue serialization', () => {
    it('executes parallel enqueueWrite calls sequentially', async () => {
      db = newInMemoryDB();
      await db.initialize();

      const order: number[] = [];

      const p1 = db.enqueueWrite(() => {
        order.push(1);
        return 'a';
      });
      const p2 = db.enqueueWrite(() => {
        order.push(2);
        return 'b';
      });
      const p3 = db.enqueueWrite(() => {
        order.push(3);
        return 'c';
      });

      const results = await Promise.all([p1, p2, p3]);
      expect(results).toEqual(['a', 'b', 'c']);
      expect(order).toEqual([1, 2, 3]);
    });

    it('propagates errors from write callbacks', async () => {
      db = newInMemoryDB();
      await db.initialize();

      await expect(
        db.enqueueWrite(() => {
          throw new Error('write failed');
        })
      ).rejects.toThrow('write failed');
    });

    it('continues processing after a failed write', async () => {
      db = newInMemoryDB();
      await db.initialize();

      const p1 = db.enqueueWrite(() => {
        throw new Error('fail');
      });
      const p2 = db.enqueueWrite(() => 'success');

      await expect(p1).rejects.toThrow('fail');
      await expect(p2).resolves.toBe('success');
    });
  });

  describe('close()', () => {
    it('rejects new writes after close', async () => {
      db = newInMemoryDB();
      await db.initialize();
      await db.close();

      await expect(
        db.enqueueWrite(() => 'should fail')
      ).rejects.toThrow(InternalError);
      await expect(
        db.enqueueWrite(() => 'should fail')
      ).rejects.toThrow('Database is closed');
    });

    it('is idempotent — multiple close calls do not throw', async () => {
      db = newInMemoryDB();
      await db.initialize();
      await db.close();
      await db.close(); // Should not throw
      await db.close(); // Should not throw
    });

    it('drains pending writes before closing', async () => {
      db = newInMemoryDB();
      await db.initialize();

      let executed = false;
      const writePromise = db.enqueueWrite(() => {
        executed = true;
        return 42;
      });

      await db.close();
      expect(await writePromise).toBe(42);
      expect(executed).toBe(true);
    });
  });

  describe('newInMemoryDB()', () => {
    it('creates a working in-memory database', async () => {
      db = newInMemoryDB();
      expect(db.getPath()).toBe(':memory:');
      await db.initialize();
      expect(db.getDB()).toBeDefined();
    });
  });

  describe('getPath()', () => {
    it('returns the configured path', () => {
      db = new Database('/tmp/test.db');
      expect(db.getPath()).toBe('/tmp/test.db');
    });
  });

  describe('high-water mark backpressure', () => {
    it('accepts both normal and low priority writes under threshold', async () => {
      db = newInMemoryDB();
      await db.initialize();

      const result = await db.enqueueWrite(() => 'ok', 'normal');
      expect(result).toBe('ok');

      const lowResult = await db.enqueueWrite(() => 'low-ok', 'low');
      expect(lowResult).toBe('low-ok');
    });
  });

  describe('getConnection()', () => {
    it('throws InternalError before initialize', () => {
      db = newInMemoryDB();
      expect(() => db.getConnection()).toThrow(InternalError);
      expect(() => db.getConnection()).toThrow('Database not initialized');
    });

    it('returns the raw connection after initialize', async () => {
      db = newInMemoryDB();
      await db.initialize();
      const conn = db.getConnection();
      expect(conn).toBeDefined();
      // Verify it's a real better-sqlite3 connection by running a query
      const result = conn.prepare('SELECT 1 AS val').get() as { val: number };
      expect(result.val).toBe(1);
    });
  });
});
