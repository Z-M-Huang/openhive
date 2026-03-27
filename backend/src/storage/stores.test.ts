/**
 * Layer 2 Phase Gate — Storage
 *
 * Tests with REAL SQLite (in-memory via ':memory:'):
 * - UT-2: Schema creates all 9 tables, WAL mode enabled
 * - Org store: addTeam, getTeam, getChildren, getAncestors, removeTeam
 * - Task queue: enqueue with priorities, dequeue returns highest priority first,
 *   peek doesn't remove, updateStatus
 * - Trigger dedup: recordEvent + checkDedup, cleanExpired
 * - Log store: append + query by level and since
 * - Escalation: create + getByCorrelationId + updateStatus
 * - UT-23: Memory store: writeFile + readFile + listFiles, path traversal rejection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { createDatabase, createTables } from './database.js';
import type { DatabaseInstance } from './database.js';
import { OrgStore } from './stores/org-store.js';
import { TaskQueueStore } from './stores/task-queue-store.js';
import { TriggerStore } from './stores/trigger-store.js';
import { LogStore } from './stores/log-store.js';
import { EscalationStore } from './stores/escalation-store.js';
import { MemoryStore } from './stores/memory-store.js';
import { TeamStatus, TaskStatus, TaskPriority } from '../domain/types.js';
import type { OrgTreeNode, LogEntry, EscalationCorrelation } from '../domain/types.js';
import { ValidationError } from '../domain/errors.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `openhive-l2-${randomBytes(8).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeNode(overrides: Partial<OrgTreeNode> & { teamId: string; name: string }): OrgTreeNode {
  return {
    parentId: null,
    status: TeamStatus.Idle,
    agents: [],
    children: [],
    ...overrides,
  };
}

// ── UT-2: Schema + WAL ─────────────────────────────────────────────────────

describe('UT-2: Schema and WAL mode', () => {
  let instance: DatabaseInstance;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    instance = createDatabase(join(tmpDir, 'test.db'));
    createTables(instance.raw);
  });

  afterEach(() => {
    instance.raw.close();
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it('WAL mode is enabled', () => {
    const result = instance.raw.pragma('journal_mode') as Array<{ journal_mode: string }>;
    expect(result[0]?.journal_mode).toBe('wal');
  });

  it('creates all 9 tables', () => {
    const tables = instance.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;

    const tableNames = tables.map((t) => t.name).sort();
    expect(tableNames).toEqual([
      'channel_interactions',
      'escalation_correlations',
      'log_entries',
      'org_tree',
      'scope_keywords',
      'task_queue',
      'team_status',
      'trigger_configs',
      'trigger_dedup',
    ]);
  });

  it('creates indexes on task_queue', () => {
    const indexes = instance.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='task_queue'")
      .all() as Array<{ name: string }>;

    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain('idx_task_queue_team_id');
    expect(indexNames).toContain('idx_task_queue_status');
  });

  it('creates indexes on log_entries', () => {
    const indexes = instance.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='log_entries'")
      .all() as Array<{ name: string }>;

    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain('idx_log_entries_level');
    expect(indexNames).toContain('idx_log_entries_created_at');
  });

  it('creates index on escalation_correlations', () => {
    const indexes = instance.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='escalation_correlations'")
      .all() as Array<{ name: string }>;

    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain('idx_escalation_source_team');
  });
});

// ── Org Store ───────────────────────────────────────────────────────────────

describe('Org Store', () => {
  let instance: DatabaseInstance;
  let store: OrgStore;

  beforeEach(() => {
    instance = createDatabase(':memory:');
    createTables(instance.raw);
    store = new OrgStore(instance.db);
  });

  afterEach(() => {
    instance.raw.close();
  });

  it('addTeam + getTeam returns the team', () => {
    const node = makeNode({ teamId: 'tid-root-001', name: 'root' });
    store.addTeam(node);

    const result = store.getTeam('tid-root-001');
    expect(result).toBeDefined();
    expect(result?.teamId).toBe('tid-root-001');
    expect(result?.name).toBe('root');
    expect(result?.status).toBe(TeamStatus.Idle);
  });

  it('getTeam returns undefined for nonexistent id', () => {
    expect(store.getTeam('nonexistent')).toBeUndefined();
  });

  it('getChildren returns child teams', () => {
    store.addTeam(makeNode({ teamId: 'tid-parent-001', name: 'parent' }));
    store.addTeam(makeNode({ teamId: 'tid-child-a', name: 'child-a', parentId: 'tid-parent-001' }));
    store.addTeam(makeNode({ teamId: 'tid-child-b', name: 'child-b', parentId: 'tid-parent-001' }));
    store.addTeam(makeNode({ teamId: 'tid-other-001', name: 'other' }));

    const children = store.getChildren('tid-parent-001');
    expect(children).toHaveLength(2);
    expect(children.map((c) => c.name).sort()).toEqual(['child-a', 'child-b']);
  });

  it('getAncestors walks parent chain to root', () => {
    store.addTeam(makeNode({ teamId: 'tid-root-001', name: 'root' }));
    store.addTeam(makeNode({ teamId: 'tid-mid-001', name: 'mid', parentId: 'tid-root-001' }));
    store.addTeam(makeNode({ teamId: 'tid-leaf-001', name: 'leaf', parentId: 'tid-mid-001' }));

    const ancestors = store.getAncestors('tid-leaf-001');
    expect(ancestors).toHaveLength(2);
    expect(ancestors[0]?.name).toBe('mid');
    expect(ancestors[1]?.name).toBe('root');
  });

  it('getAncestors returns empty for root node', () => {
    store.addTeam(makeNode({ teamId: 'tid-root-001', name: 'root' }));
    const ancestors = store.getAncestors('tid-root-001');
    expect(ancestors).toHaveLength(0);
  });

  it('removeTeam deletes the team', () => {
    store.addTeam(makeNode({ teamId: 'tid-rm-001', name: 'doomed' }));
    expect(store.getTeam('tid-rm-001')).toBeDefined();

    store.removeTeam('tid-rm-001');
    expect(store.getTeam('tid-rm-001')).toBeUndefined();
  });

  it('getAll returns all teams', () => {
    store.addTeam(makeNode({ teamId: 'tid-a', name: 'a' }));
    store.addTeam(makeNode({ teamId: 'tid-b', name: 'b' }));

    const all = store.getAll();
    expect(all).toHaveLength(2);
  });
});

// ── Task Queue Store ────────────────────────────────────────────────────────

describe('Task Queue Store', () => {
  let instance: DatabaseInstance;
  let store: TaskQueueStore;

  beforeEach(() => {
    instance = createDatabase(':memory:');
    createTables(instance.raw);
    store = new TaskQueueStore(instance.db);
  });

  afterEach(() => {
    instance.raw.close();
  });

  it('enqueue returns a task id', () => {
    const id = store.enqueue('team-1', 'do stuff', 'normal');
    expect(id).toMatch(/^task-/);
  });

  it('dequeue returns highest priority first', () => {
    store.enqueue('team-1', 'low task', TaskPriority.Low);
    store.enqueue('team-1', 'critical task', TaskPriority.Critical);
    store.enqueue('team-1', 'normal task', TaskPriority.Normal);

    const first = store.dequeue('team-1');
    expect(first?.task).toBe('critical task');
    expect(first?.status).toBe(TaskStatus.Running);

    const second = store.dequeue('team-1');
    expect(second?.task).toBe('normal task');

    const third = store.dequeue('team-1');
    expect(third?.task).toBe('low task');
  });

  it('dequeue respects FIFO within same priority', () => {
    store.enqueue('team-1', 'first', TaskPriority.Normal);
    store.enqueue('team-1', 'second', TaskPriority.Normal);

    const first = store.dequeue('team-1');
    expect(first?.task).toBe('first');

    const second = store.dequeue('team-1');
    expect(second?.task).toBe('second');
  });

  it('dequeue returns undefined when queue is empty', () => {
    expect(store.dequeue('team-1')).toBeUndefined();
  });

  it('peek does not remove the task', () => {
    store.enqueue('team-1', 'peeked', TaskPriority.Normal);

    const peeked = store.peek('team-1');
    expect(peeked?.task).toBe('peeked');
    expect(peeked?.status).toBe(TaskStatus.Pending);

    // Still available for dequeue
    const dequeued = store.dequeue('team-1');
    expect(dequeued?.task).toBe('peeked');
  });

  it('getByTeam returns all tasks for a team', () => {
    store.enqueue('team-1', 'task-a', TaskPriority.Normal);
    store.enqueue('team-1', 'task-b', TaskPriority.High);
    store.enqueue('team-2', 'task-c', TaskPriority.Normal);

    const team1Tasks = store.getByTeam('team-1');
    expect(team1Tasks).toHaveLength(2);
  });

  it('updateStatus changes task status', () => {
    const id = store.enqueue('team-1', 'will complete', TaskPriority.Normal);
    store.updateStatus(id, TaskStatus.Completed);

    const tasks = store.getByTeam('team-1');
    expect(tasks[0]?.status).toBe(TaskStatus.Completed);
  });

  it('getPending returns all pending tasks across teams', () => {
    store.enqueue('team-1', 'pending-1', TaskPriority.Normal);
    store.enqueue('team-2', 'pending-2', TaskPriority.High);

    // Dequeue one to make it running
    store.dequeue('team-1');

    const pending = store.getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.task).toBe('pending-2');
  });

  it('enqueue with correlationId preserves it', () => {
    const id = store.enqueue('team-1', 'correlated', TaskPriority.Normal, 'corr-123');
    const tasks = store.getByTeam('team-1');
    const task = tasks.find((t) => t.id === id);
    expect(task?.correlationId).toBe('corr-123');
  });
});

// ── Trigger Dedup Store ─────────────────────────────────────────────────────

describe('Trigger Dedup Store', () => {
  let instance: DatabaseInstance;
  let store: TriggerStore;

  beforeEach(() => {
    instance = createDatabase(':memory:');
    createTables(instance.raw);
    store = new TriggerStore(instance.db);
  });

  afterEach(() => {
    instance.raw.close();
  });

  it('checkDedup returns false for unknown event', () => {
    expect(store.checkDedup('evt-1', 'src-1')).toBe(false);
  });

  it('recordEvent + checkDedup returns true within TTL', () => {
    store.recordEvent('evt-1', 'src-1', 300);
    expect(store.checkDedup('evt-1', 'src-1')).toBe(true);
  });

  it('checkDedup returns false after TTL expires', () => {
    // Record with 0-second TTL (already expired)
    store.recordEvent('evt-expired', 'src-1', 0);

    // Manually backdate the created_at to ensure expiry
    instance.raw
      .prepare("UPDATE trigger_dedup SET created_at = datetime('now', '-10 seconds') WHERE event_id = ?")
      .run('evt-expired');

    expect(store.checkDedup('evt-expired', 'src-1')).toBe(false);
  });

  it('cleanExpired removes expired events', () => {
    store.recordEvent('evt-old', 'src-1', 1);

    // Backdate to make it expired
    instance.raw
      .prepare("UPDATE trigger_dedup SET created_at = datetime('now', '-60 seconds') WHERE event_id = ?")
      .run('evt-old');

    store.recordEvent('evt-fresh', 'src-1', 3600);

    const deleted = store.cleanExpired();
    expect(deleted).toBe(1);

    expect(store.checkDedup('evt-old', 'src-1')).toBe(false);
    expect(store.checkDedup('evt-fresh', 'src-1')).toBe(true);
  });

  it('recordEvent updates existing event on conflict', () => {
    store.recordEvent('evt-1', 'src-1', 60);
    store.recordEvent('evt-1', 'src-1', 120);

    // Should still exist and be deduped
    expect(store.checkDedup('evt-1', 'src-1')).toBe(true);
  });
});

// ── Log Store ───────────────────────────────────────────────────────────────

describe('Log Store', () => {
  let instance: DatabaseInstance;
  let store: LogStore;

  beforeEach(() => {
    instance = createDatabase(':memory:');
    createTables(instance.raw);
    store = new LogStore(instance.db);
  });

  afterEach(() => {
    instance.raw.close();
  });

  it('append + query returns the entry', () => {
    const entry: LogEntry = {
      id: 'log-1',
      level: 'info',
      message: 'test message',
      timestamp: Date.now(),
      source: 'test',
    };

    store.append(entry);
    const results = store.query({});
    expect(results).toHaveLength(1);
    expect(results[0]?.message).toBe('test message');
    expect(results[0]?.level).toBe('info');
  });

  it('query filters by level', () => {
    store.append({ id: '1', level: 'info', message: 'info msg', timestamp: Date.now(), source: 'test' });
    store.append({ id: '2', level: 'error', message: 'error msg', timestamp: Date.now(), source: 'test' });
    store.append({ id: '3', level: 'info', message: 'info msg 2', timestamp: Date.now(), source: 'test' });

    const errors = store.query({ level: 'error' });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe('error msg');
  });

  it('query filters by since', () => {
    const past = Date.now() - 60_000;
    const now = Date.now();

    store.append({ id: '1', level: 'info', message: 'old', timestamp: past, source: 'test' });
    store.append({ id: '2', level: 'info', message: 'new', timestamp: now, source: 'test' });

    const recent = store.query({ since: now - 1000 });
    expect(recent).toHaveLength(1);
    expect(recent[0]?.message).toBe('new');
  });

  it('query respects limit', () => {
    for (let i = 0; i < 10; i++) {
      store.append({ id: `log-${i}`, level: 'info', message: `msg ${i}`, timestamp: Date.now() + i, source: 'test' });
    }

    const limited = store.query({ limit: 3 });
    expect(limited).toHaveLength(3);
  });

  it('preserves metadata through context', () => {
    store.append({
      id: '1',
      level: 'info',
      message: 'with meta',
      timestamp: Date.now(),
      source: 'test',
      metadata: { key: 'value', count: 42 },
    });

    const results = store.query({});
    expect(results[0]?.metadata).toEqual({ key: 'value', count: 42 });
  });
});

// ── Escalation Store ────────────────────────────────────────────────────────

describe('Escalation Store', () => {
  let instance: DatabaseInstance;
  let store: EscalationStore;

  beforeEach(() => {
    instance = createDatabase(':memory:');
    createTables(instance.raw);
    store = new EscalationStore(instance.db);
  });

  afterEach(() => {
    instance.raw.close();
  });

  it('create + getByCorrelationId returns the correlation', () => {
    const corr: EscalationCorrelation = {
      correlationId: 'corr-001',
      sourceTeam: 'team-a',
      targetTeam: 'team-b',
      taskId: 'task-123',
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    store.create(corr);
    const result = store.getByCorrelationId('corr-001');

    expect(result).toBeDefined();
    expect(result?.sourceTeam).toBe('team-a');
    expect(result?.targetTeam).toBe('team-b');
    expect(result?.taskId).toBe('task-123');
    expect(result?.status).toBe('pending');
  });

  it('getByCorrelationId returns undefined for nonexistent', () => {
    expect(store.getByCorrelationId('nonexistent')).toBeUndefined();
  });

  it('updateStatus changes the status', () => {
    store.create({
      correlationId: 'corr-002',
      sourceTeam: 'team-a',
      targetTeam: 'team-b',
      taskId: null,
      status: 'pending',
      createdAt: new Date().toISOString(),
    });

    store.updateStatus('corr-002', 'resolved');

    const result = store.getByCorrelationId('corr-002');
    expect(result?.status).toBe('resolved');
  });
});

// ── UT-23: Memory Store ─────────────────────────────────────────────────────

describe('UT-23: Memory Store', () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(tmpDir);
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it('writeFile + readFile round-trips content', () => {
    store.writeFile('my-team', 'notes.md', '# Notes\nHello world');
    const content = store.readFile('my-team', 'notes.md');
    expect(content).toBe('# Notes\nHello world');
  });

  it('readFile returns undefined for nonexistent file', () => {
    expect(store.readFile('my-team', 'nope.txt')).toBeUndefined();
  });

  it('listFiles returns filenames', () => {
    store.writeFile('my-team', 'a.txt', 'aaa');
    store.writeFile('my-team', 'b.txt', 'bbb');

    const files = store.listFiles('my-team');
    expect(files.sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('listFiles returns empty for nonexistent team', () => {
    expect(store.listFiles('ghost-team')).toEqual([]);
  });

  it('rejects path traversal in team name', () => {
    expect(() => store.readFile('../etc', 'passwd')).toThrow(ValidationError);
    expect(() => store.writeFile('../etc', 'passwd', 'bad')).toThrow(ValidationError);
    expect(() => store.listFiles('../etc')).toThrow(ValidationError);
  });

  it('rejects path traversal in filename', () => {
    expect(() => store.readFile('my-team', '../secret.txt')).toThrow(ValidationError);
    expect(() => store.writeFile('my-team', '../../etc/passwd', 'bad')).toThrow(ValidationError);
    expect(() => store.readFile('my-team', 'sub/file.txt')).toThrow(ValidationError);
  });

  it('rejects invalid team slug format', () => {
    expect(() => store.readFile('UPPER', 'file.txt')).toThrow(ValidationError);
    expect(() => store.readFile('has spaces', 'file.txt')).toThrow(ValidationError);
    expect(() => store.readFile('', 'file.txt')).toThrow(ValidationError);
  });
});
