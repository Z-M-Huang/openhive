/**
 * Layer 2 Phase Gate: Storage + Security integration tests.
 *
 * Exercises real SQLite (in-memory), real Drizzle ORM, real store
 * implementations, real KeyManager with Argon2id, and real Transactor.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';

import { Database, newInMemoryDB } from '../storage/database.js';
import {
  newTaskStore,
  newLogStore,
  newMemoryStore,
  newIntegrationStore,
  newTransactor,
} from '../storage/stores/index.js';
import * as schema from '../storage/schema.js';
import { KeyManagerImpl } from '../security/key-manager.js';
import { LogLevel } from '../domain/enums.js';
import type { Task, LogEntry, MemoryEntry, Integration } from '../domain/domain.js';
import { CycleDetectedError, InvalidTransitionError } from '../domain/errors.js';

// ---------------------------------------------------------------------------
// Shared DB lifecycle
// ---------------------------------------------------------------------------

let db: Database;

beforeEach(async () => {
  db = newInMemoryDB();
  await db.initialize();
});

afterEach(async () => {
  await db.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const now = Date.now();

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    parent_id: '',
    team_slug: 'test-team',
    agent_aid: 'aid-test-abc',
    title: 'Test task',
    status: 'pending',
    prompt: 'do something',
    result: '',
    error: '',
    blocked_by: null,
    priority: 0,
    retry_count: 0,
    max_retries: 3,
    created_at: now,
    updated_at: now,
    completed_at: null,
    ...overrides,
  };
}

function makeLogEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    id: 0,
    level: LogLevel.Info,
    event_type: 'test',
    component: 'test',
    action: '',
    message: 'test log entry',
    params: '',
    team_slug: '',
    task_id: '',
    agent_aid: '',
    request_id: '',
    correlation_id: '',
    error: '',
    duration_ms: 0,
    created_at: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe('Layer 2: Storage + Security', () => {

  // -------------------------------------------------------------------------
  // 1. Database init + pragma verification
  // -------------------------------------------------------------------------

  describe('Database init + pragma verification', () => {
    it('initializes with correct pragmas', () => {
      const conn = db.getConnection();

      // In-memory databases report 'memory' for journal_mode (WAL is applied but
      // SQLite falls back to 'memory' for in-memory databases)
      const journalMode = conn.pragma('journal_mode', { simple: true }) as string;
      expect(['wal', 'memory']).toContain(journalMode);

      const fk = conn.pragma('foreign_keys', { simple: true });
      expect(fk).toBe(1);

      const busyTimeout = conn.pragma('busy_timeout', { simple: true });
      expect(busyTimeout).toBe(5000);
    });
  });

  // -------------------------------------------------------------------------
  // 2. TaskStore CRUD + dependency cycle detection
  // -------------------------------------------------------------------------

  describe('TaskStore CRUD + dependency cycle detection', () => {
    it('creates tasks with dependencies and detects cycles', async () => {
      const store = newTaskStore(db);

      // Create task A (no dependencies)
      const taskA = makeTask({ id: 'task-a' });
      await store.create(taskA);

      // Create task B blocked by A
      const taskB = makeTask({ id: 'task-b', blocked_by: ['task-a'] });
      await store.create(taskB);

      // Create task C blocked by B
      const taskC = makeTask({ id: 'task-c', blocked_by: ['task-b'] });
      await store.create(taskC);

      // Verify tasks are retrievable
      const fetchedA = await store.get('task-a');
      expect(fetchedA.id).toBe('task-a');
      expect(fetchedA.status).toBe('pending');

      const fetchedB = await store.get('task-b');
      expect(fetchedB.blocked_by).toEqual(['task-a']);

      const fetchedC = await store.get('task-c');
      expect(fetchedC.blocked_by).toEqual(['task-b']);

      // Attempt to add dependency A -> C (creating cycle A->B->C->A)
      // This means: update task A to be blocked_by C, which creates a cycle
      await expect(
        store.validateDependencies('task-a', ['task-c'])
      ).rejects.toThrow(CycleDetectedError);
    });
  });

  // -------------------------------------------------------------------------
  // 3. LogStore batch insert + query + retention delete
  // -------------------------------------------------------------------------

  describe('LogStore batch insert + query + retention delete', () => {
    it('batch inserts, queries by level/time, and deletes by level+time', async () => {
      const store = newLogStore(db);

      // Create 100 entries across levels and time ranges
      const entries: LogEntry[] = [];
      const baseTime = Date.now() - 200_000; // 200 seconds ago

      for (let i = 0; i < 100; i++) {
        const level = i < 30 ? LogLevel.Debug
          : i < 60 ? LogLevel.Info
          : i < 80 ? LogLevel.Warn
          : LogLevel.Error;
        entries.push(makeLogEntry({
          level,
          message: `entry-${i}`,
          created_at: baseTime + i * 1000,
        }));
      }

      await store.create(entries);

      // Verify count
      const total = await store.count();
      expect(total).toBe(100);

      // Query by level filter: level >= Warn (30) should return Warn + Error entries
      const warnAndAbove = await store.query({ level: LogLevel.Warn });
      expect(warnAndAbove.length).toBe(40); // 20 warn + 20 error

      // Query by time range
      const midpoint = baseTime + 50_000; // 50 seconds after base
      const recentEntries = await store.query({
        since: new Date(midpoint),
      });
      expect(recentEntries.length).toBe(50); // entries 50-99

      // Delete debug entries older than midpoint
      const deleted = await store.deleteByLevelBefore(
        LogLevel.Debug,
        new Date(midpoint),
      );
      expect(deleted).toBe(30); // 30 debug entries (indices 0-29), all before midpoint

      // Verify remaining count
      const remaining = await store.count();
      expect(remaining).toBe(70);
    });
  });

  // -------------------------------------------------------------------------
  // 4. KeyManager encrypt + decrypt round-trip
  // -------------------------------------------------------------------------

  describe('KeyManager encrypt + decrypt round-trip', () => {
    it('encrypts and decrypts successfully when unlocked, throws when locked', async () => {
      const km = new KeyManagerImpl();
      const testKey = 'test-master-key-at-least-32-chars-long!!';

      // Unlock
      await km.unlock(testKey);
      expect(km.isUnlocked()).toBe(true);

      // Encrypt
      const plaintext = 'super secret credential value';
      const ciphertext = await km.encrypt(plaintext);
      expect(ciphertext).toContain(':'); // iv:payload format
      expect(ciphertext).not.toContain(plaintext);

      // Decrypt
      const decrypted = await km.decrypt(ciphertext);
      expect(decrypted).toBe(plaintext);

      // Lock
      await km.lock();
      expect(km.isUnlocked()).toBe(false);

      // Verify encrypt throws when locked
      await expect(km.encrypt('anything')).rejects.toThrow(/locked/i);
      await expect(km.decrypt(ciphertext)).rejects.toThrow(/locked/i);
    });
  });

  // -------------------------------------------------------------------------
  // 5. MemoryStore save + search + soft delete + purge
  // -------------------------------------------------------------------------

  describe('MemoryStore save + search + soft delete + purge', () => {
    it('saves, searches, soft-deletes, and purges memories', async () => {
      const store = newMemoryStore(db);

      // Save 3 memory entries
      const m1: MemoryEntry = {
        id: 0,
        agent_aid: 'aid-agent-abc',
        team_slug: 'test-team',
        content: 'The user prefers concise responses',
        memory_type: 'curated',
        created_at: now,
        deleted_at: null,
      };
      const m2: MemoryEntry = {
        id: 0,
        agent_aid: 'aid-agent-abc',
        team_slug: 'test-team',
        content: 'Project uses TypeScript strict mode',
        memory_type: 'curated',
        created_at: now + 1000,
        deleted_at: null,
      };
      const m3: MemoryEntry = {
        id: 0,
        agent_aid: 'aid-other-def',
        team_slug: 'test-team',
        content: 'The user prefers detailed explanations',
        memory_type: 'daily',
        created_at: now + 2000,
        deleted_at: null,
      };

      await store.save(m1);
      await store.save(m2);
      await store.save(m3);

      // Search by keyword "prefers" -> should find m1 and m3
      const prefersResults = await store.search({ query: 'prefers' });
      expect(prefersResults.length).toBe(2);

      // Search by agent -> only aid-agent-abc entries
      const agentResults = await store.search({ agentAid: 'aid-agent-abc' });
      expect(agentResults.length).toBe(2);

      // Soft delete agent aid-agent-abc's memories
      const softDeleted = await store.softDeleteByAgent('aid-agent-abc');
      expect(softDeleted).toBe(2);

      // Search should now exclude soft-deleted entries
      const afterSoftDelete = await store.search({ query: 'prefers' });
      expect(afterSoftDelete.length).toBe(1);
      expect(afterSoftDelete[0].agent_aid).toBe('aid-other-def');

      // Purge soft-deleted entries older than 0 days (purge all)
      const purged = await store.purgeDeleted(0);
      expect(purged).toBe(2);

      // Only m3 remains
      const allRemaining = await store.search({});
      expect(allRemaining.length).toBe(1);
      expect(allRemaining[0].content).toBe('The user prefers detailed explanations');
    });
  });

  // -------------------------------------------------------------------------
  // 6. Write queue serialization
  // -------------------------------------------------------------------------

  describe('Write queue serialization', () => {
    it('serializes 50 concurrent writes without interleaving', async () => {
      const logStore = newLogStore(db);

      // Fire 50 concurrent enqueueWrite calls that each insert a numbered row
      const promises: Promise<void>[] = [];
      for (let i = 0; i < 50; i++) {
        promises.push(
          logStore.create([
            makeLogEntry({
              message: `write-${String(i).padStart(3, '0')}`,
              created_at: now + i,
            }),
          ])
        );
      }

      await Promise.all(promises);

      // Verify all 50 rows present
      const total = await logStore.count();
      expect(total).toBe(50);

      // Retrieve in insertion order (oldest first)
      const oldest = await logStore.getOldest(50);
      expect(oldest.length).toBe(50);

      // Each row should have a unique message
      const messages = new Set(oldest.map(e => e.message));
      expect(messages.size).toBe(50);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Transactor rollback
  // -------------------------------------------------------------------------

  describe('Transactor rollback', () => {
    it('rolls back transaction when callback throws', async () => {
      const transactor = newTransactor(db);
      const logStore = newLogStore(db);

      // Start transaction, insert a row, then throw
      await expect(
        transactor.withTransaction(() => {
          db.getDB().insert(schema.logEntries).values({
            level: LogLevel.Info,
            event_type: 'rollback-test',
            component: 'test',
            action: '',
            message: 'should not persist',
            params: '',
            team_slug: '',
            task_id: '',
            agent_aid: '',
            request_id: '',
            correlation_id: '',
            error: '',
            duration_ms: 0,
            created_at: now,
          }).run();
          throw new Error('intentional rollback');
        })
      ).rejects.toThrow('intentional rollback');

      // Verify row not persisted
      const count = await logStore.count();
      expect(count).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // 8. IntegrationStore lifecycle
  // -------------------------------------------------------------------------

  describe('IntegrationStore lifecycle', () => {
    it('transitions through valid states and rejects invalid transitions', async () => {
      const store = newIntegrationStore(db);

      const integration: Integration = {
        id: 'int-test-001',
        team_id: 'tid-test-abc',
        name: 'test-integration',
        config_path: '/workspace/integrations/test.yaml',
        status: 'proposed',
        created_at: now,
      };

      // Create in proposed state
      await store.create(integration);
      const fetched = await store.get('int-test-001');
      expect(fetched.status).toBe('proposed');

      // Valid transitions: proposed -> validated -> tested -> approved -> active
      await store.updateStatus('int-test-001', 'validated');
      expect((await store.get('int-test-001')).status).toBe('validated');

      await store.updateStatus('int-test-001', 'tested');
      expect((await store.get('int-test-001')).status).toBe('tested');

      await store.updateStatus('int-test-001', 'approved');
      expect((await store.get('int-test-001')).status).toBe('approved');

      await store.updateStatus('int-test-001', 'active');
      expect((await store.get('int-test-001')).status).toBe('active');

      // Create another integration to test invalid transition
      const integration2: Integration = {
        id: 'int-test-002',
        team_id: 'tid-test-abc',
        name: 'test-integration-2',
        config_path: '/workspace/integrations/test2.yaml',
        status: 'proposed',
        created_at: now,
      };
      await store.create(integration2);

      // Invalid transition: proposed -> active directly (skipping intermediate states)
      await expect(
        store.updateStatus('int-test-002', 'active')
      ).rejects.toThrow(InvalidTransitionError);
    });
  });
});
