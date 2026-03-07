/**
 * Tests for LogStoreImpl.
 *
 * Uses newInMemoryDB() so every test runs against a clean, isolated SQLite
 * database. Because the in-memory reader and writer are separate connections
 * that cannot share data, the store is created WITHOUT a separate reader —
 * this causes the store to use db.writer for both reads and writes, ensuring
 * test visibility of newly inserted rows.
 *
 * Covers:
 *   - Batch create inserts multiple entries
 *   - Query filters by level, component, team_name, task_id
 *   - Query filters by since/until date range
 *   - Query respects limit and offset
 *   - DeleteBefore removes old entries and returns count
 *   - Count returns total entry count
 *   - GetOldest returns entries in chronological order
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { newInMemoryDB } from './db.js';
import { newLogStore } from './log-store.js';
import type { DB } from './db.js';
import type { LogStoreImpl } from './log-store.js';
import type { LogEntry } from '../domain/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let db: DB;
let store: LogStoreImpl;

beforeEach(() => {
  db = newInMemoryDB();
  store = newLogStore(db);
});

afterEach(() => {
  db.close();
});

/**
 * makeEntry builds a minimal valid LogEntry for tests.
 * created_at defaults to a predictable Unix-ms value to allow ordering
 * assertions. id=0 triggers autoincrement when inserted.
 */
function makeEntry(overrides: Partial<LogEntry> & { created_at?: Date }): LogEntry {
  return {
    id: 0,
    level: overrides.level ?? 'info',
    component: overrides.component ?? 'test-component',
    action: overrides.action ?? 'test-action',
    message: overrides.message ?? 'test message',
    params: overrides.params,
    team_name: overrides.team_name,
    task_id: overrides.task_id,
    agent_name: overrides.agent_name,
    request_id: overrides.request_id,
    error: overrides.error,
    duration_ms: overrides.duration_ms,
    created_at: overrides.created_at ?? new Date(1_000_000),
  };
}

// ---------------------------------------------------------------------------
// Batch create
// ---------------------------------------------------------------------------

describe('create', () => {
  it('inserts a single entry and assigns an autoincrement id', async () => {
    const entry = makeEntry({ message: 'hello' });
    await store.create([entry]);

    const total = await store.count();
    expect(total).toBe(1);
  });

  it('inserts multiple entries in one batch call', async () => {
    const entries = [
      makeEntry({ message: 'first', created_at: new Date(1_000) }),
      makeEntry({ message: 'second', created_at: new Date(2_000) }),
      makeEntry({ message: 'third', created_at: new Date(3_000) }),
    ];
    await store.create(entries);

    const total = await store.count();
    expect(total).toBe(3);
  });

  it('is a no-op for an empty array', async () => {
    await store.create([]);
    const total = await store.count();
    expect(total).toBe(0);
  });

  it('round-trips all fields correctly', async () => {
    const entry = makeEntry({
      level: 'error',
      component: 'orchestrator',
      action: 'dispatch',
      message: 'dispatch failed',
      params: { key: 'value', count: 42 },
      team_name: 'alpha',
      task_id: 'task-abc',
      agent_name: 'lead-agent',
      request_id: 'req-123',
      error: 'connection refused',
      duration_ms: 150,
      created_at: new Date(5_000_000),
    });
    await store.create([entry]);

    // Retrieve via getOldest to confirm roundtrip
    const results = await store.getOldest(1);
    expect(results).toHaveLength(1);
    const got = results[0]!;

    expect(got.level).toBe('error');
    expect(got.component).toBe('orchestrator');
    expect(got.action).toBe('dispatch');
    expect(got.message).toBe('dispatch failed');
    expect(got.params).toEqual({ key: 'value', count: 42 });
    expect(got.team_name).toBe('alpha');
    expect(got.task_id).toBe('task-abc');
    expect(got.agent_name).toBe('lead-agent');
    expect(got.request_id).toBe('req-123');
    expect(got.error).toBe('connection refused');
    expect(got.duration_ms).toBe(150);
    expect(got.created_at.getTime()).toBe(5_000_000);
  });

  it('stores optional fields as undefined when absent', async () => {
    const entry = makeEntry({});
    await store.create([entry]);

    const results = await store.getOldest(1);
    const got = results[0]!;
    expect(got.params).toBeUndefined();
    expect(got.team_name).toBeUndefined();
    expect(got.task_id).toBeUndefined();
    expect(got.agent_name).toBeUndefined();
    expect(got.request_id).toBeUndefined();
    expect(got.error).toBeUndefined();
    expect(got.duration_ms).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Query — level filter
// ---------------------------------------------------------------------------

describe('query — level filter', () => {
  beforeEach(async () => {
    await store.create([
      makeEntry({ level: 'debug', message: 'debug msg', created_at: new Date(1_000) }),
      makeEntry({ level: 'info', message: 'info msg', created_at: new Date(2_000) }),
      makeEntry({ level: 'warn', message: 'warn msg', created_at: new Date(3_000) }),
      makeEntry({ level: 'error', message: 'error msg', created_at: new Date(4_000) }),
    ]);
  });

  it('returns all entries when level filter is absent', async () => {
    const results = await store.query({});
    expect(results).toHaveLength(4);
  });

  it('returns entries with level >= debug (all)', async () => {
    const results = await store.query({ level: 'debug' });
    expect(results).toHaveLength(4);
  });

  it('returns entries with level >= info (info, warn, error)', async () => {
    const results = await store.query({ level: 'info' });
    expect(results).toHaveLength(3);
    const levels = results.map((e) => e.level);
    expect(levels).not.toContain('debug');
    expect(levels).toContain('info');
    expect(levels).toContain('warn');
    expect(levels).toContain('error');
  });

  it('returns entries with level >= warn (warn, error)', async () => {
    const results = await store.query({ level: 'warn' });
    expect(results).toHaveLength(2);
    expect(results.map((e) => e.level)).toEqual(expect.arrayContaining(['warn', 'error']));
  });

  it('returns only error entries when level=error', async () => {
    const results = await store.query({ level: 'error' });
    expect(results).toHaveLength(1);
    expect(results[0]!.level).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// Query — component filter
// ---------------------------------------------------------------------------

describe('query — component filter', () => {
  beforeEach(async () => {
    await store.create([
      makeEntry({ component: 'api', created_at: new Date(1_000) }),
      makeEntry({ component: 'api', created_at: new Date(2_000) }),
      makeEntry({ component: 'ws', created_at: new Date(3_000) }),
    ]);
  });

  it('returns only entries matching the component', async () => {
    const results = await store.query({ component: 'api' });
    expect(results).toHaveLength(2);
    expect(results.every((e) => e.component === 'api')).toBe(true);
  });

  it('returns empty when no entries match the component', async () => {
    const results = await store.query({ component: 'unknown' });
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Query — team_name filter
// ---------------------------------------------------------------------------

describe('query — team_name filter', () => {
  beforeEach(async () => {
    await store.create([
      makeEntry({ team_name: 'alpha', created_at: new Date(1_000) }),
      makeEntry({ team_name: 'alpha', created_at: new Date(2_000) }),
      makeEntry({ team_name: 'beta', created_at: new Date(3_000) }),
      makeEntry({ created_at: new Date(4_000) }), // no team_name
    ]);
  });

  it('returns only entries for the specified team', async () => {
    const results = await store.query({ team_name: 'alpha' });
    expect(results).toHaveLength(2);
    expect(results.every((e) => e.team_name === 'alpha')).toBe(true);
  });

  it('returns empty when no entries match the team', async () => {
    const results = await store.query({ team_name: 'gamma' });
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Query — task_id filter
// ---------------------------------------------------------------------------

describe('query — task_id filter', () => {
  beforeEach(async () => {
    await store.create([
      makeEntry({ task_id: 'task-1', created_at: new Date(1_000) }),
      makeEntry({ task_id: 'task-1', created_at: new Date(2_000) }),
      makeEntry({ task_id: 'task-2', created_at: new Date(3_000) }),
    ]);
  });

  it('returns only entries for the specified task_id', async () => {
    const results = await store.query({ task_id: 'task-1' });
    expect(results).toHaveLength(2);
    expect(results.every((e) => e.task_id === 'task-1')).toBe(true);
  });

  it('returns empty when task_id does not match', async () => {
    const results = await store.query({ task_id: 'task-99' });
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Query — since/until date range
// ---------------------------------------------------------------------------

describe('query — since/until date range', () => {
  beforeEach(async () => {
    // Five entries at t=1000, 2000, 3000, 4000, 5000
    for (let i = 1; i <= 5; i++) {
      await store.create([makeEntry({ created_at: new Date(i * 1_000) })]);
    }
  });

  it('returns all entries when no since/until is specified', async () => {
    const results = await store.query({ limit: 10 });
    expect(results).toHaveLength(5);
  });

  it('filters entries with created_at >= since', async () => {
    // since = 3000 → entries at t=3000, 4000, 5000
    const results = await store.query({ since: new Date(3_000), limit: 10 });
    expect(results).toHaveLength(3);
  });

  it('includes entries exactly at the since boundary', async () => {
    const results = await store.query({ since: new Date(3_000), limit: 10 });
    const times = results.map((e) => e.created_at.getTime()).sort((a, b) => a - b);
    expect(times[0]).toBe(3_000);
  });

  it('filters entries with created_at <= until', async () => {
    // until = 3000 → entries at t=1000, 2000, 3000
    const results = await store.query({ until: new Date(3_000), limit: 10 });
    expect(results).toHaveLength(3);
  });

  it('includes entries exactly at the until boundary', async () => {
    const results = await store.query({ until: new Date(3_000), limit: 10 });
    const times = results.map((e) => e.created_at.getTime()).sort((a, b) => a - b);
    expect(times[times.length - 1]).toBe(3_000);
  });

  it('applies both since and until together', async () => {
    // since=2000, until=4000 → entries at t=2000, 3000, 4000
    const results = await store.query({
      since: new Date(2_000),
      until: new Date(4_000),
      limit: 10,
    });
    expect(results).toHaveLength(3);
    const times = results.map((e) => e.created_at.getTime()).sort((a, b) => a - b);
    expect(times).toEqual([2_000, 3_000, 4_000]);
  });

  it('returns empty when since is after all entries', async () => {
    const results = await store.query({ since: new Date(999_999) });
    expect(results).toHaveLength(0);
  });

  it('returns empty when until is before all entries', async () => {
    const results = await store.query({ until: new Date(0) });
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Query — limit and offset
// ---------------------------------------------------------------------------

describe('query — limit and offset', () => {
  beforeEach(async () => {
    // 10 entries at t=1000..10000
    const entries: LogEntry[] = [];
    for (let i = 1; i <= 10; i++) {
      entries.push(makeEntry({ created_at: new Date(i * 1_000) }));
    }
    await store.create(entries);
  });

  it('applies a default limit of 100 when no limit is specified', async () => {
    // Only 10 entries exist, all should be returned (well under default 100)
    const results = await store.query({});
    expect(results).toHaveLength(10);
  });

  it('limits the number of returned entries', async () => {
    const results = await store.query({ limit: 3 });
    expect(results).toHaveLength(3);
  });

  it('returns entries ordered by created_at DESC', async () => {
    const results = await store.query({ limit: 5 });
    const times = results.map((e) => e.created_at.getTime());
    // Should be descending: 10000, 9000, 8000, 7000, 6000
    expect(times).toEqual([10_000, 9_000, 8_000, 7_000, 6_000]);
  });

  it('applies offset correctly', async () => {
    // offset=0, limit=3 → newest 3: t=10000, 9000, 8000
    // offset=3, limit=3 → next 3: t=7000, 6000, 5000
    const first = await store.query({ limit: 3, offset: 0 });
    const second = await store.query({ limit: 3, offset: 3 });

    expect(first).toHaveLength(3);
    expect(second).toHaveLength(3);

    const firstTimes = first.map((e) => e.created_at.getTime());
    const secondTimes = second.map((e) => e.created_at.getTime());

    expect(firstTimes).toEqual([10_000, 9_000, 8_000]);
    expect(secondTimes).toEqual([7_000, 6_000, 5_000]);

    // No overlap
    const firstSet = new Set(firstTimes);
    expect(secondTimes.some((t) => firstSet.has(t))).toBe(false);
  });

  it('returns empty when offset is beyond the total row count', async () => {
    const results = await store.query({ limit: 10, offset: 100 });
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DeleteBefore
// ---------------------------------------------------------------------------

describe('deleteBefore', () => {
  beforeEach(async () => {
    // Five entries at t=1000, 2000, 3000, 4000, 5000
    const entries: LogEntry[] = [];
    for (let i = 1; i <= 5; i++) {
      entries.push(makeEntry({ created_at: new Date(i * 1_000) }));
    }
    await store.create(entries);
  });

  it('deletes entries with created_at strictly before the cutoff', async () => {
    // cutoff=3000 → delete t=1000, t=2000 (2 rows)
    const count = await store.deleteBefore(new Date(3_000));
    expect(count).toBe(2);

    const remaining = await store.query({ limit: 10 });
    expect(remaining).toHaveLength(3);
    const times = remaining.map((e) => e.created_at.getTime()).sort((a, b) => a - b);
    expect(times).toEqual([3_000, 4_000, 5_000]);
  });

  it('does not delete entries at exactly the cutoff timestamp', async () => {
    // strict less-than: t=3000 is NOT deleted
    await store.deleteBefore(new Date(3_000));
    const results = await store.query({ since: new Date(3_000), until: new Date(3_000), limit: 10 });
    expect(results).toHaveLength(1);
    expect(results[0]!.created_at.getTime()).toBe(3_000);
  });

  it('returns 0 when no entries are older than the cutoff', async () => {
    const count = await store.deleteBefore(new Date(0));
    expect(count).toBe(0);
  });

  it('deletes all entries when cutoff is past all timestamps', async () => {
    const count = await store.deleteBefore(new Date(999_999));
    expect(count).toBe(5);

    const total = await store.count();
    expect(total).toBe(0);
  });

  it('returns the correct count of deleted rows', async () => {
    const count = await store.deleteBefore(new Date(4_000));
    // t=1000, 2000, 3000 → 3 rows deleted
    expect(count).toBe(3);

    const remaining = await store.query({ limit: 10 });
    expect(remaining).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Count
// ---------------------------------------------------------------------------

describe('count', () => {
  it('returns 0 for an empty table', async () => {
    const total = await store.count();
    expect(total).toBe(0);
  });

  it('returns the exact number of entries after inserts', async () => {
    await store.create([
      makeEntry({ created_at: new Date(1_000) }),
      makeEntry({ created_at: new Date(2_000) }),
      makeEntry({ created_at: new Date(3_000) }),
    ]);
    const total = await store.count();
    expect(total).toBe(3);
  });

  it('decrements after deleteBefore', async () => {
    await store.create([
      makeEntry({ created_at: new Date(1_000) }),
      makeEntry({ created_at: new Date(5_000) }),
    ]);
    await store.deleteBefore(new Date(3_000));
    const total = await store.count();
    expect(total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// GetOldest
// ---------------------------------------------------------------------------

describe('getOldest', () => {
  beforeEach(async () => {
    // 5 entries inserted in non-chronological order
    await store.create([
      makeEntry({ message: 'msg-3', created_at: new Date(3_000) }),
      makeEntry({ message: 'msg-1', created_at: new Date(1_000) }),
      makeEntry({ message: 'msg-5', created_at: new Date(5_000) }),
      makeEntry({ message: 'msg-2', created_at: new Date(2_000) }),
      makeEntry({ message: 'msg-4', created_at: new Date(4_000) }),
    ]);
  });

  it('returns entries in chronological order (ASC)', async () => {
    const results = await store.getOldest(5);
    const times = results.map((e) => e.created_at.getTime());
    expect(times).toEqual([1_000, 2_000, 3_000, 4_000, 5_000]);
  });

  it('returns only the N oldest entries', async () => {
    const results = await store.getOldest(2);
    expect(results).toHaveLength(2);
    const times = results.map((e) => e.created_at.getTime());
    expect(times).toEqual([1_000, 2_000]);
  });

  it('returns all entries when limit >= total count', async () => {
    const results = await store.getOldest(100);
    expect(results).toHaveLength(5);
  });

  it('returns empty array for an empty table', async () => {
    const emptyDB = newInMemoryDB();
    const emptyStore = newLogStore(emptyDB);
    const results = await emptyStore.getOldest(10);
    expect(results).toHaveLength(0);
    emptyDB.close();
  });

  it('returns the single oldest entry when limit=1', async () => {
    const results = await store.getOldest(1);
    expect(results).toHaveLength(1);
    expect(results[0]!.created_at.getTime()).toBe(1_000);
  });
});

// ---------------------------------------------------------------------------
// Combined filters (compose level + component + date range)
// ---------------------------------------------------------------------------

describe('query — combined filters', () => {
  beforeEach(async () => {
    await store.create([
      makeEntry({ level: 'info', component: 'api', team_name: 'alpha', created_at: new Date(1_000) }),
      makeEntry({ level: 'error', component: 'api', team_name: 'alpha', created_at: new Date(2_000) }),
      makeEntry({ level: 'warn', component: 'ws', team_name: 'beta', created_at: new Date(3_000) }),
      makeEntry({ level: 'info', component: 'api', team_name: 'beta', created_at: new Date(4_000) }),
    ]);
  });

  it('combines level and component filters', async () => {
    const results = await store.query({ level: 'error', component: 'api', limit: 10 });
    expect(results).toHaveLength(1);
    expect(results[0]!.level).toBe('error');
    expect(results[0]!.component).toBe('api');
  });

  it('combines component and team_name filters', async () => {
    const results = await store.query({ component: 'api', team_name: 'alpha', limit: 10 });
    expect(results).toHaveLength(2);
    expect(results.every((e) => e.component === 'api' && e.team_name === 'alpha')).toBe(true);
  });

  it('combines level and date range filters', async () => {
    // level >= info, since=2000 → entries at t=2000 (error), t=3000 (warn), t=4000 (info)
    const results = await store.query({
      level: 'info',
      since: new Date(2_000),
      limit: 10,
    });
    expect(results).toHaveLength(3);
    const levels = results.map((e) => e.level);
    expect(levels).not.toContain('debug');
  });
});
