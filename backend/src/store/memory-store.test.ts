/**
 * Tests for MemoryStoreImpl.
 *
 * Uses newInMemoryDB() so every test runs against a clean, isolated SQLite
 * database. The store is created WITHOUT a separate reader — this causes it
 * to use db.writer for both reads and writes, ensuring test visibility.
 *
 * Covers:
 *   - Create and retrieve a memory entry
 *   - Get throws NotFoundError for missing ID
 *   - GetByAgentAndKey retrieves by compound key
 *   - GetByAgentAndKey throws NotFoundError for missing compound key
 *   - Update modifies fields and returns success
 *   - Update throws NotFoundError for missing memory
 *   - Delete removes entry
 *   - DeleteAllByAgent removes all entries for an agent (hard delete)
 *   - ListByAgent returns entries ordered by updated_at DESC
 *   - Soft-delete hides records from get/getByAgentAndKey/listByAgent
 *   - purgeDeleted removes old soft-deleted records but keeps recent ones
 *   - search by keyword with limit
 *   - search by team
 *   - Upsert after soft-delete creates new entry (not updating deleted record)
 *   - LIKE wildcard characters in keyword are escaped
 *   - deleteAllByAgent still hard-deletes (backward compat)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { newInMemoryDB } from './db.js';
import { newMemoryStore } from './memory-store.js';
import { NotFoundError } from '../domain/errors.js';
import type { DB } from './db.js';
import type { MemoryStoreImpl } from './memory-store.js';
import type { AgentMemory } from '../domain/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let db: DB;
let store: MemoryStoreImpl;

beforeEach(() => {
  db = newInMemoryDB();
  store = newMemoryStore(db);
});

afterEach(() => {
  db.close();
});

function makeMemory(overrides: Partial<AgentMemory> & { id: string }): AgentMemory {
  return {
    id: overrides.id,
    agent_aid: overrides.agent_aid ?? 'aid-agent-001',
    key: overrides.key ?? 'test-key',
    value: overrides.value ?? 'test-value',
    metadata: overrides.metadata,
    team_slug: overrides.team_slug,
    deleted_at: overrides.deleted_at,
    created_at: overrides.created_at ?? new Date(1_000_000),
    updated_at: overrides.updated_at ?? new Date(1_000_000),
  };
}

// ---------------------------------------------------------------------------
// Create and retrieve
// ---------------------------------------------------------------------------

describe('create and get', () => {
  it('creates a memory entry and retrieves it by ID', async () => {
    const mem = makeMemory({ id: 'mem-1' });
    await store.create(mem);

    const retrieved = await store.get('mem-1');
    expect(retrieved.id).toBe('mem-1');
    expect(retrieved.agent_aid).toBe('aid-agent-001');
    expect(retrieved.key).toBe('test-key');
    expect(retrieved.value).toBe('test-value');
  });

  it('round-trips all fields including optional metadata', async () => {
    const mem = makeMemory({
      id: 'mem-full',
      agent_aid: 'aid-x',
      key: 'pref.theme',
      value: 'dark',
      metadata: '{"source":"user"}',
      created_at: new Date(2_000_000),
      updated_at: new Date(3_000_000),
    });
    await store.create(mem);

    const retrieved = await store.get('mem-full');
    expect(retrieved.agent_aid).toBe('aid-x');
    expect(retrieved.key).toBe('pref.theme');
    expect(retrieved.value).toBe('dark');
    expect(retrieved.metadata).toBe('{"source":"user"}');
    expect(retrieved.created_at.getTime()).toBe(2_000_000);
    expect(retrieved.updated_at.getTime()).toBe(3_000_000);
  });

  it('returns undefined for metadata when not set', async () => {
    const mem = makeMemory({ id: 'mem-noopt' });
    await store.create(mem);

    const retrieved = await store.get('mem-noopt');
    expect(retrieved.metadata).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Get throws NotFoundError
// ---------------------------------------------------------------------------

describe('get — not found', () => {
  it('throws NotFoundError when the memory does not exist', async () => {
    await expect(store.get('mem-missing')).rejects.toThrow(NotFoundError);
  });

  it('includes the resource and ID in the error', async () => {
    let caught: NotFoundError | undefined;
    try {
      await store.get('mem-gone');
    } catch (e) {
      if (e instanceof NotFoundError) caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught!.resource).toBe('agent_memory');
    expect(caught!.id).toBe('mem-gone');
  });
});

// ---------------------------------------------------------------------------
// GetByAgentAndKey
// ---------------------------------------------------------------------------

describe('getByAgentAndKey', () => {
  it('retrieves a memory entry by agent AID and key', async () => {
    await store.create(makeMemory({ id: 'mem-ak', agent_aid: 'aid-x', key: 'color' }));

    const retrieved = await store.getByAgentAndKey('aid-x', 'color');
    expect(retrieved.id).toBe('mem-ak');
    expect(retrieved.agent_aid).toBe('aid-x');
    expect(retrieved.key).toBe('color');
  });

  it('throws NotFoundError when agent+key combination does not exist', async () => {
    await store.create(makeMemory({ id: 'mem-other', agent_aid: 'aid-x', key: 'color' }));

    await expect(store.getByAgentAndKey('aid-x', 'shape')).rejects.toThrow(NotFoundError);
    await expect(store.getByAgentAndKey('aid-y', 'color')).rejects.toThrow(NotFoundError);
  });

  it('includes compound key in error message', async () => {
    let caught: NotFoundError | undefined;
    try {
      await store.getByAgentAndKey('aid-a', 'missing-key');
    } catch (e) {
      if (e instanceof NotFoundError) caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught!.id).toBe('aid-a/missing-key');
  });
});

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

describe('update', () => {
  it('updates fields on an existing memory entry', async () => {
    const mem = makeMemory({ id: 'mem-upd', value: 'old' });
    await store.create(mem);

    const updated: AgentMemory = {
      ...mem,
      value: 'new-value',
      metadata: '{"updated":true}',
      updated_at: new Date(5_000_000),
    };
    await store.update(updated);

    const retrieved = await store.get('mem-upd');
    expect(retrieved.value).toBe('new-value');
    expect(retrieved.metadata).toBe('{"updated":true}');
    expect(retrieved.updated_at.getTime()).toBe(5_000_000);
  });

  it('throws NotFoundError when updating a non-existent memory', async () => {
    const mem = makeMemory({ id: 'mem-nonexist' });
    await expect(store.update(mem)).rejects.toThrow(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

describe('delete', () => {
  it('removes a memory entry by ID', async () => {
    await store.create(makeMemory({ id: 'mem-del' }));
    await store.delete('mem-del');

    await expect(store.get('mem-del')).rejects.toThrow(NotFoundError);
  });

  it('does not throw when deleting a non-existent ID', async () => {
    await expect(store.delete('mem-ghost')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// DeleteAllByAgent
// ---------------------------------------------------------------------------

describe('deleteAllByAgent', () => {
  it('removes all entries for the given agent and returns count', async () => {
    await store.create(makeMemory({ id: 'mem-a1', agent_aid: 'aid-a', key: 'k1' }));
    await store.create(makeMemory({ id: 'mem-a2', agent_aid: 'aid-a', key: 'k2' }));
    await store.create(makeMemory({ id: 'mem-b1', agent_aid: 'aid-b', key: 'k1' }));

    const count = await store.deleteAllByAgent('aid-a');
    expect(count).toBe(2);

    const remaining = await store.listByAgent('aid-a');
    expect(remaining).toEqual([]);

    // Other agent's entries are untouched
    const bEntries = await store.listByAgent('aid-b');
    expect(bEntries).toHaveLength(1);
  });

  it('returns 0 when the agent has no entries', async () => {
    const count = await store.deleteAllByAgent('aid-none');
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ListByAgent
// ---------------------------------------------------------------------------

describe('listByAgent', () => {
  it('returns entries ordered by updated_at DESC', async () => {
    await store.create(
      makeMemory({ id: 'mem-l1', agent_aid: 'aid-a', key: 'k1', updated_at: new Date(1_000) }),
    );
    await store.create(
      makeMemory({ id: 'mem-l2', agent_aid: 'aid-a', key: 'k2', updated_at: new Date(3_000) }),
    );
    await store.create(
      makeMemory({ id: 'mem-l3', agent_aid: 'aid-a', key: 'k3', updated_at: new Date(2_000) }),
    );

    const result = await store.listByAgent('aid-a');
    expect(result).toHaveLength(3);
    expect(result[0]!.id).toBe('mem-l2');
    expect(result[1]!.id).toBe('mem-l3');
    expect(result[2]!.id).toBe('mem-l1');
  });

  it('returns empty array for agent with no entries', async () => {
    const result = await store.listByAgent('aid-none');
    expect(result).toEqual([]);
  });

  it('does not include entries from other agents', async () => {
    await store.create(makeMemory({ id: 'mem-x', agent_aid: 'aid-x', key: 'k1' }));
    await store.create(makeMemory({ id: 'mem-y', agent_aid: 'aid-y', key: 'k1' }));

    const result = await store.listByAgent('aid-x');
    expect(result).toHaveLength(1);
    expect(result[0]!.agent_aid).toBe('aid-x');
  });
});

// ---------------------------------------------------------------------------
// Team slug round-trip
// ---------------------------------------------------------------------------

describe('team_slug round-trip', () => {
  it('persists and retrieves team_slug', async () => {
    await store.create(makeMemory({ id: 'mem-ts', team_slug: 'research-team' }));
    const retrieved = await store.get('mem-ts');
    expect(retrieved.team_slug).toBe('research-team');
  });

  it('returns undefined for team_slug when not set', async () => {
    await store.create(makeMemory({ id: 'mem-nots' }));
    const retrieved = await store.get('mem-nots');
    expect(retrieved.team_slug).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Soft-delete hides records
// ---------------------------------------------------------------------------

describe('soft-delete hides records', () => {
  it('get() throws NotFoundError for soft-deleted record', async () => {
    await store.create(makeMemory({ id: 'mem-sd1', agent_aid: 'aid-a', key: 'k1' }));
    await store.softDeleteByAgent('aid-a');

    await expect(store.get('mem-sd1')).rejects.toThrow(NotFoundError);
  });

  it('getByAgentAndKey() throws NotFoundError for soft-deleted record', async () => {
    await store.create(makeMemory({ id: 'mem-sd2', agent_aid: 'aid-a', key: 'k1' }));
    await store.softDeleteByAgent('aid-a');

    await expect(store.getByAgentAndKey('aid-a', 'k1')).rejects.toThrow(NotFoundError);
  });

  it('listByAgent() excludes soft-deleted records', async () => {
    await store.create(makeMemory({ id: 'mem-sd3', agent_aid: 'aid-a', key: 'k1' }));
    await store.create(makeMemory({ id: 'mem-sd4', agent_aid: 'aid-a', key: 'k2' }));
    await store.softDeleteByAgent('aid-a');

    const result = await store.listByAgent('aid-a');
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// softDeleteByAgent
// ---------------------------------------------------------------------------

describe('softDeleteByAgent', () => {
  it('sets deleted_at on all records for the agent and returns count', async () => {
    await store.create(makeMemory({ id: 'mem-sda1', agent_aid: 'aid-a', key: 'k1' }));
    await store.create(makeMemory({ id: 'mem-sda2', agent_aid: 'aid-a', key: 'k2' }));
    await store.create(makeMemory({ id: 'mem-sdb1', agent_aid: 'aid-b', key: 'k1' }));

    const count = await store.softDeleteByAgent('aid-a');
    expect(count).toBe(2);

    // aid-b's entries are untouched
    const bEntries = await store.listByAgent('aid-b');
    expect(bEntries).toHaveLength(1);
  });

  it('returns 0 when agent has no records', async () => {
    const count = await store.softDeleteByAgent('aid-none');
    expect(count).toBe(0);
  });

  it('does not double-delete already soft-deleted records', async () => {
    await store.create(makeMemory({ id: 'mem-dd', agent_aid: 'aid-a', key: 'k1' }));
    await store.softDeleteByAgent('aid-a');
    const count = await store.softDeleteByAgent('aid-a');
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// softDeleteByTeam
// ---------------------------------------------------------------------------

describe('softDeleteByTeam', () => {
  it('sets deleted_at on all records for the team and returns count', async () => {
    await store.create(
      makeMemory({ id: 'mem-sdt1', agent_aid: 'aid-a', key: 'k1', team_slug: 'team-x' }),
    );
    await store.create(
      makeMemory({ id: 'mem-sdt2', agent_aid: 'aid-b', key: 'k2', team_slug: 'team-x' }),
    );
    await store.create(
      makeMemory({ id: 'mem-sdt3', agent_aid: 'aid-c', key: 'k3', team_slug: 'team-y' }),
    );

    const count = await store.softDeleteByTeam('team-x');
    expect(count).toBe(2);

    // team-y entries are untouched
    const results = await store.search({ team_slug: 'team-y' });
    expect(results).toHaveLength(1);
  });

  it('returns 0 when team has no records', async () => {
    const count = await store.softDeleteByTeam('team-none');
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// purgeDeleted
// ---------------------------------------------------------------------------

describe('purgeDeleted', () => {
  it('hard-deletes soft-deleted records older than threshold', async () => {
    // Create and soft-delete a record
    await store.create(makeMemory({ id: 'mem-purge1', agent_aid: 'aid-a', key: 'k1' }));
    // Directly set a very old deleted_at via raw SQL
    db._writerConn
      .prepare('UPDATE agent_memories SET deleted_at = ? WHERE id = ?')
      .run(Date.now() - 100 * 24 * 60 * 60 * 1000, 'mem-purge1');

    const count = await store.purgeDeleted(30);
    expect(count).toBe(1);
  });

  it('keeps recently soft-deleted records', async () => {
    await store.create(makeMemory({ id: 'mem-purge2', agent_aid: 'aid-a', key: 'k2' }));
    await store.softDeleteByAgent('aid-a');

    // Purge with 30 days — the just-soft-deleted record should survive
    const count = await store.purgeDeleted(30);
    expect(count).toBe(0);
  });

  it('returns 0 when no soft-deleted records exist', async () => {
    await store.create(makeMemory({ id: 'mem-purge3', agent_aid: 'aid-a', key: 'k3' }));
    const count = await store.purgeDeleted(30);
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

describe('search', () => {
  it('searches by keyword in key', async () => {
    await store.create(
      makeMemory({ id: 'mem-s1', agent_aid: 'aid-a', key: 'user-preference', value: 'dark' }),
    );
    await store.create(
      makeMemory({ id: 'mem-s2', agent_aid: 'aid-a', key: 'system-config', value: 'enabled' }),
    );

    const results = await store.search({ keyword: 'preference' });
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe('mem-s1');
  });

  it('searches by keyword in value', async () => {
    await store.create(
      makeMemory({ id: 'mem-s3', agent_aid: 'aid-a', key: 'color', value: 'dark-blue' }),
    );
    await store.create(
      makeMemory({ id: 'mem-s4', agent_aid: 'aid-a', key: 'size', value: 'large' }),
    );

    const results = await store.search({ keyword: 'dark' });
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe('mem-s3');
  });

  it('filters by agent_aid', async () => {
    await store.create(makeMemory({ id: 'mem-s5', agent_aid: 'aid-a', key: 'k1' }));
    await store.create(makeMemory({ id: 'mem-s6', agent_aid: 'aid-b', key: 'k1' }));

    const results = await store.search({ agent_aid: 'aid-a' });
    expect(results).toHaveLength(1);
    expect(results[0]!.agent_aid).toBe('aid-a');
  });

  it('filters by team_slug', async () => {
    await store.create(
      makeMemory({ id: 'mem-s7', agent_aid: 'aid-a', key: 'k1', team_slug: 'team-x' }),
    );
    await store.create(
      makeMemory({ id: 'mem-s8', agent_aid: 'aid-a', key: 'k2', team_slug: 'team-y' }),
    );

    const results = await store.search({ team_slug: 'team-x' });
    expect(results).toHaveLength(1);
    expect(results[0]!.team_slug).toBe('team-x');
  });

  it('respects limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      await store.create(
        makeMemory({
          id: `mem-lim-${i}`,
          agent_aid: 'aid-a',
          key: `k${i}`,
          updated_at: new Date(1_000_000 + i * 1000),
        }),
      );
    }

    const results = await store.search({ agent_aid: 'aid-a', limit: 3 });
    expect(results).toHaveLength(3);
  });

  it('defaults to limit 100', async () => {
    // Create 3 records — all should be returned since 3 < 100
    for (let i = 0; i < 3; i++) {
      await store.create(
        makeMemory({ id: `mem-def-${i}`, agent_aid: 'aid-a', key: `k${i}` }),
      );
    }

    const results = await store.search({ agent_aid: 'aid-a' });
    expect(results).toHaveLength(3);
  });

  it('orders results by updated_at DESC', async () => {
    await store.create(
      makeMemory({
        id: 'mem-ord1',
        agent_aid: 'aid-a',
        key: 'k1',
        updated_at: new Date(1_000),
      }),
    );
    await store.create(
      makeMemory({
        id: 'mem-ord2',
        agent_aid: 'aid-a',
        key: 'k2',
        updated_at: new Date(3_000),
      }),
    );
    await store.create(
      makeMemory({
        id: 'mem-ord3',
        agent_aid: 'aid-a',
        key: 'k3',
        updated_at: new Date(2_000),
      }),
    );

    const results = await store.search({ agent_aid: 'aid-a' });
    expect(results[0]!.id).toBe('mem-ord2');
    expect(results[1]!.id).toBe('mem-ord3');
    expect(results[2]!.id).toBe('mem-ord1');
  });

  it('excludes soft-deleted records', async () => {
    await store.create(makeMemory({ id: 'mem-srch-del', agent_aid: 'aid-a', key: 'hidden' }));
    await store.softDeleteByAgent('aid-a');

    const results = await store.search({ keyword: 'hidden' });
    expect(results).toEqual([]);
  });

  it('filters by since date', async () => {
    await store.create(
      makeMemory({
        id: 'mem-since1',
        agent_aid: 'aid-a',
        key: 'k1',
        updated_at: new Date(1_000),
      }),
    );
    await store.create(
      makeMemory({
        id: 'mem-since2',
        agent_aid: 'aid-a',
        key: 'k2',
        updated_at: new Date(5_000),
      }),
    );

    const results = await store.search({ since: new Date(3_000) });
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe('mem-since2');
  });

  it('escapes LIKE wildcard % in keyword', async () => {
    await store.create(
      makeMemory({ id: 'mem-esc1', agent_aid: 'aid-a', key: 'progress', value: '50% done' }),
    );
    await store.create(
      makeMemory({ id: 'mem-esc2', agent_aid: 'aid-a', key: 'status', value: 'completed' }),
    );

    // Search for literal "%" — should only match the record containing %
    const results = await store.search({ keyword: '%' });
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe('mem-esc1');
  });

  it('escapes LIKE wildcard _ in keyword', async () => {
    await store.create(
      makeMemory({ id: 'mem-esc3', agent_aid: 'aid-a', key: 'file_name', value: 'data' }),
    );
    await store.create(
      makeMemory({ id: 'mem-esc4', agent_aid: 'aid-a', key: 'filename', value: 'other' }),
    );

    // Search for literal "_" — should only match the record containing _
    const results = await store.search({ keyword: '_' });
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe('mem-esc3');
  });
});

// ---------------------------------------------------------------------------
// Upsert after soft-delete
// ---------------------------------------------------------------------------

describe('upsert after soft-delete', () => {
  it('creates a new entry after soft-deleting (getByAgentAndKey does not find deleted)', async () => {
    // Create and soft-delete
    await store.create(
      makeMemory({ id: 'mem-upsert1', agent_aid: 'aid-a', key: 'pref', value: 'old-value' }),
    );
    await store.softDeleteByAgent('aid-a');

    // getByAgentAndKey should throw NotFoundError for the soft-deleted record
    await expect(store.getByAgentAndKey('aid-a', 'pref')).rejects.toThrow(NotFoundError);

    // Create a new record with the same agent+key
    await store.create(
      makeMemory({
        id: 'mem-upsert2',
        agent_aid: 'aid-a',
        key: 'pref',
        value: 'new-value',
        updated_at: new Date(2_000_000),
      }),
    );

    // Should retrieve the new record
    const retrieved = await store.getByAgentAndKey('aid-a', 'pref');
    expect(retrieved.id).toBe('mem-upsert2');
    expect(retrieved.value).toBe('new-value');
  });
});

// ---------------------------------------------------------------------------
// deleteAllByAgent still hard-deletes (backward compat)
// ---------------------------------------------------------------------------

describe('deleteAllByAgent — backward compat hard delete', () => {
  it('hard-deletes all records including soft-deleted ones', async () => {
    await store.create(makeMemory({ id: 'mem-hd1', agent_aid: 'aid-a', key: 'k1' }));
    await store.create(makeMemory({ id: 'mem-hd2', agent_aid: 'aid-a', key: 'k2' }));
    // Soft-delete one
    await store.softDeleteByAgent('aid-a');
    // Create another active one
    await store.create(
      makeMemory({ id: 'mem-hd3', agent_aid: 'aid-a', key: 'k3' }),
    );

    // deleteAllByAgent should remove everything (soft-deleted + active)
    const count = await store.deleteAllByAgent('aid-a');
    expect(count).toBe(3);

    // Verify nothing remains at all (use raw SQL since soft-deleted records are hidden from Drizzle queries)
    const rawRows = db._writerConn
      .prepare("SELECT * FROM agent_memories WHERE agent_aid = ?")
      .all('aid-a');
    expect(rawRows).toHaveLength(0);
  });
});
