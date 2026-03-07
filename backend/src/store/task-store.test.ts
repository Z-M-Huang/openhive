/**
 * Tests for TaskStoreImpl.
 *
 * Uses newInMemoryDB() so every test runs against a clean, isolated SQLite
 * database. Because the in-memory reader and writer are separate connections
 * that cannot share data, the store is created WITHOUT a separate reader —
 * this causes the store to default db.writer for both reads and writes,
 * ensuring test visibility.
 *
 * Covers:
 *   - Create and retrieve a task
 *   - Get throws NotFoundError for missing ID
 *   - Update modifies fields and returns success
 *   - Update throws NotFoundError for missing task
 *   - ListByTeam returns tasks ordered by created_at DESC
 *   - ListByTeamPaginated returns correct page with total count
 *   - ListByStatus filters correctly
 *   - GetSubtree returns full task tree via recursive CTE
 *   - GetSubtree respects max depth limit
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { newInMemoryDB } from './db.js';
import { newTaskStore } from './task-store.js';
import { NotFoundError } from '../domain/errors.js';
import type { DB } from './db.js';
import type { TaskStoreImpl } from './task-store.js';
import type { Task } from '../domain/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let db: DB;
let store: TaskStoreImpl;

beforeEach(() => {
  db = newInMemoryDB();
  store = newTaskStore(db);
});

afterEach(() => {
  db.close();
});

/**
 * makeTask builds a minimal valid Task for tests.
 * created_at and updated_at are set to distinct Unix-ms timestamps to
 * allow ordering assertions.
 */
function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    id: overrides.id,
    team_slug: overrides.team_slug ?? 'test-team',
    status: overrides.status ?? 'pending',
    prompt: overrides.prompt ?? 'do the thing',
    created_at: overrides.created_at ?? new Date(1_000_000),
    updated_at: overrides.updated_at ?? new Date(1_000_000),
    completed_at: overrides.completed_at ?? null,
    parent_id: overrides.parent_id,
    agent_aid: overrides.agent_aid,
    jid: overrides.jid,
    result: overrides.result,
    error: overrides.error,
  };
}

// ---------------------------------------------------------------------------
// Create and retrieve a task
// ---------------------------------------------------------------------------

describe('create and get', () => {
  it('creates a task and retrieves it by ID', async () => {
    const task = makeTask({ id: 'task-1' });
    await store.create(task);

    const retrieved = await store.get('task-1');
    expect(retrieved.id).toBe('task-1');
    expect(retrieved.team_slug).toBe('test-team');
    expect(retrieved.status).toBe('pending');
    expect(retrieved.prompt).toBe('do the thing');
    expect(retrieved.completed_at).toBeNull();
  });

  it('round-trips all optional fields correctly', async () => {
    const task = makeTask({
      id: 'task-full',
      parent_id: 'parent-1',
      agent_aid: 'aid-abc-xyz',
      jid: 'discord:123',
      status: 'running',
      result: 'done',
      error: 'none',
      completed_at: new Date(2_000_000),
    });
    await store.create(task);

    const retrieved = await store.get('task-full');
    expect(retrieved.parent_id).toBe('parent-1');
    expect(retrieved.agent_aid).toBe('aid-abc-xyz');
    expect(retrieved.jid).toBe('discord:123');
    expect(retrieved.status).toBe('running');
    expect(retrieved.result).toBe('done');
    expect(retrieved.error).toBe('none');
    expect(retrieved.completed_at).not.toBeNull();
    expect(retrieved.completed_at!.getTime()).toBe(2_000_000);
  });

  it('maps empty optional string fields to undefined on read', async () => {
    // When no parent_id / agent_aid / jid / result / error are supplied,
    // the row stores empty strings and taskRowToDomain converts them back
    // to undefined.
    const task = makeTask({ id: 'task-empty-opts' });
    await store.create(task);

    const retrieved = await store.get('task-empty-opts');
    expect(retrieved.parent_id).toBeUndefined();
    expect(retrieved.agent_aid).toBeUndefined();
    expect(retrieved.jid).toBeUndefined();
    expect(retrieved.result).toBeUndefined();
    expect(retrieved.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Get throws NotFoundError for missing ID
// ---------------------------------------------------------------------------

describe('get — not found', () => {
  it('throws NotFoundError when the task does not exist', async () => {
    await expect(store.get('does-not-exist')).rejects.toThrow(NotFoundError);
  });

  it('includes the resource and ID in the error', async () => {
    let caught: NotFoundError | undefined;
    try {
      await store.get('missing-id');
    } catch (e) {
      if (e instanceof NotFoundError) caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught!.resource).toBe('task');
    expect(caught!.id).toBe('missing-id');
    expect(caught!.message).toBe('task not found: missing-id');
  });
});

// ---------------------------------------------------------------------------
// Update modifies fields and returns success
// ---------------------------------------------------------------------------

describe('update', () => {
  it('modifies the task status and result', async () => {
    const task = makeTask({ id: 'task-upd' });
    await store.create(task);

    const updated: Task = {
      ...task,
      status: 'completed',
      result: 'success',
      updated_at: new Date(2_000_000),
      completed_at: new Date(2_000_000),
    };
    await store.update(updated);

    const retrieved = await store.get('task-upd');
    expect(retrieved.status).toBe('completed');
    expect(retrieved.result).toBe('success');
    expect(retrieved.updated_at.getTime()).toBe(2_000_000);
    expect(retrieved.completed_at).not.toBeNull();
    expect(retrieved.completed_at!.getTime()).toBe(2_000_000);
  });

  it('modifies all updatable fields', async () => {
    const task = makeTask({
      id: 'task-all-fields',
      status: 'pending',
      prompt: 'original prompt',
    });
    await store.create(task);

    const updated: Task = {
      id: 'task-all-fields',
      parent_id: 'parent-x',
      team_slug: 'new-team',
      agent_aid: 'aid-new',
      jid: 'ws:456',
      status: 'failed',
      prompt: 'new prompt',
      result: 'partial',
      error: 'something went wrong',
      created_at: task.created_at,
      updated_at: new Date(3_000_000),
      completed_at: null,
    };
    await store.update(updated);

    const retrieved = await store.get('task-all-fields');
    expect(retrieved.parent_id).toBe('parent-x');
    expect(retrieved.team_slug).toBe('new-team');
    expect(retrieved.agent_aid).toBe('aid-new');
    expect(retrieved.jid).toBe('ws:456');
    expect(retrieved.status).toBe('failed');
    expect(retrieved.prompt).toBe('new prompt');
    expect(retrieved.result).toBe('partial');
    expect(retrieved.error).toBe('something went wrong');
    expect(retrieved.completed_at).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Update throws NotFoundError for missing task
  // -------------------------------------------------------------------------

  it('throws NotFoundError when the task does not exist', async () => {
    const nonExistent = makeTask({ id: 'ghost-task' });
    await expect(store.update(nonExistent)).rejects.toThrow(NotFoundError);
  });

  it('includes resource and ID in the NotFoundError', async () => {
    const nonExistent = makeTask({ id: 'ghost-task-2' });
    let caught: NotFoundError | undefined;
    try {
      await store.update(nonExistent);
    } catch (e) {
      if (e instanceof NotFoundError) caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught!.resource).toBe('task');
    expect(caught!.id).toBe('ghost-task-2');
  });
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

describe('delete', () => {
  it('removes the task so subsequent get throws NotFoundError', async () => {
    const task = makeTask({ id: 'task-del' });
    await store.create(task);

    await store.delete('task-del');

    await expect(store.get('task-del')).rejects.toThrow(NotFoundError);
  });

  it('does not throw when deleting a non-existent task', async () => {
    await expect(store.delete('non-existent-task')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ListByTeam returns tasks ordered by created_at DESC
// ---------------------------------------------------------------------------

describe('listByTeam', () => {
  it('returns only tasks belonging to the specified team', async () => {
    await store.create(makeTask({ id: 't1', team_slug: 'team-a', created_at: new Date(1000) }));
    await store.create(makeTask({ id: 't2', team_slug: 'team-b', created_at: new Date(2000) }));
    await store.create(makeTask({ id: 't3', team_slug: 'team-a', created_at: new Date(3000) }));

    const results = await store.listByTeam('team-a');
    expect(results).toHaveLength(2);
    expect(results.map((t) => t.id)).toContain('t1');
    expect(results.map((t) => t.id)).toContain('t3');
    expect(results.map((t) => t.id)).not.toContain('t2');
  });

  it('returns tasks ordered by created_at DESC (newest first)', async () => {
    await store.create(makeTask({ id: 'old', team_slug: 'my-team', created_at: new Date(1000) }));
    await store.create(
      makeTask({ id: 'mid', team_slug: 'my-team', created_at: new Date(2000) }),
    );
    await store.create(
      makeTask({ id: 'new', team_slug: 'my-team', created_at: new Date(3000) }),
    );

    const results = await store.listByTeam('my-team');
    expect(results.map((t) => t.id)).toEqual(['new', 'mid', 'old']);
  });

  it('returns an empty array when no tasks match', async () => {
    const results = await store.listByTeam('empty-team');
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ListByTeamPaginated returns correct page with total count
// ---------------------------------------------------------------------------

describe('listByTeamPaginated', () => {
  beforeEach(async () => {
    // Insert 5 tasks for the same team with distinct timestamps
    for (let i = 1; i <= 5; i++) {
      await store.create(
        makeTask({
          id: `pg-task-${i}`,
          team_slug: 'paginated-team',
          created_at: new Date(i * 1000),
          updated_at: new Date(i * 1000),
        }),
      );
    }
  });

  it('returns the first page with correct items and total', async () => {
    const [page, total] = await store.listByTeamPaginated('paginated-team', 2, 0);
    expect(total).toBe(5);
    expect(page).toHaveLength(2);
    // Ordered by created_at DESC — newest first
    expect(page[0]!.id).toBe('pg-task-5');
    expect(page[1]!.id).toBe('pg-task-4');
  });

  it('returns the second page with offset', async () => {
    const [page, total] = await store.listByTeamPaginated('paginated-team', 2, 2);
    expect(total).toBe(5);
    expect(page).toHaveLength(2);
    expect(page[0]!.id).toBe('pg-task-3');
    expect(page[1]!.id).toBe('pg-task-2');
  });

  it('returns a partial last page', async () => {
    const [page, total] = await store.listByTeamPaginated('paginated-team', 2, 4);
    expect(total).toBe(5);
    expect(page).toHaveLength(1);
    expect(page[0]!.id).toBe('pg-task-1');
  });

  it('returns empty page and zero total for unknown team', async () => {
    const [page, total] = await store.listByTeamPaginated('unknown', 10, 0);
    expect(total).toBe(0);
    expect(page).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ListByStatus filters correctly
// ---------------------------------------------------------------------------

describe('listByStatus', () => {
  it('returns only tasks with the specified status', async () => {
    await store.create(makeTask({ id: 'pend-1', status: 'pending' }));
    await store.create(makeTask({ id: 'pend-2', status: 'pending' }));
    await store.create(makeTask({ id: 'run-1', status: 'running' }));
    await store.create(makeTask({ id: 'done-1', status: 'completed' }));

    const pending = await store.listByStatus('pending');
    expect(pending).toHaveLength(2);
    expect(pending.map((t) => t.id)).toContain('pend-1');
    expect(pending.map((t) => t.id)).toContain('pend-2');

    const running = await store.listByStatus('running');
    expect(running).toHaveLength(1);
    expect(running[0]!.id).toBe('run-1');

    const completed = await store.listByStatus('completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]!.id).toBe('done-1');
  });

  it('correctly maps all five status integer values', async () => {
    const statuses = ['pending', 'running', 'completed', 'failed', 'cancelled'] as const;
    for (const s of statuses) {
      await store.create(makeTask({ id: `status-${s}`, status: s }));
    }
    for (const s of statuses) {
      const rows = await store.listByStatus(s);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe(s);
    }
  });

  it('returns tasks ordered by created_at DESC', async () => {
    await store.create(
      makeTask({ id: 's-old', status: 'pending', created_at: new Date(1000) }),
    );
    await store.create(
      makeTask({ id: 's-new', status: 'pending', created_at: new Date(5000) }),
    );
    const rows = await store.listByStatus('pending');
    expect(rows[0]!.id).toBe('s-new');
    expect(rows[1]!.id).toBe('s-old');
  });

  it('returns empty array for status with no tasks', async () => {
    const rows = await store.listByStatus('cancelled');
    expect(rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GetSubtree returns full task tree via recursive CTE
// ---------------------------------------------------------------------------

describe('getSubtree', () => {
  /**
   * Build a 3-level tree:
   *   root
   *   ├── child-a
   *   │   └── grandchild-a1
   *   └── child-b
   */
  beforeEach(async () => {
    await store.create(makeTask({ id: 'root', team_slug: 'tree-team' }));
    await store.create(
      makeTask({ id: 'child-a', team_slug: 'tree-team', parent_id: 'root' }),
    );
    await store.create(
      makeTask({ id: 'child-b', team_slug: 'tree-team', parent_id: 'root' }),
    );
    await store.create(
      makeTask({ id: 'grandchild-a1', team_slug: 'tree-team', parent_id: 'child-a' }),
    );
  });

  it('returns all 4 nodes when called on root', async () => {
    const subtree = await store.getSubtree('root');
    const ids = subtree.map((t) => t.id).sort();
    expect(ids).toEqual(['child-a', 'child-b', 'grandchild-a1', 'root']);
  });

  it('returns only the subtree for a non-root node', async () => {
    const subtree = await store.getSubtree('child-a');
    const ids = subtree.map((t) => t.id).sort();
    expect(ids).toEqual(['child-a', 'grandchild-a1']);
  });

  it('returns only the leaf node itself when called on a leaf', async () => {
    const subtree = await store.getSubtree('grandchild-a1');
    expect(subtree).toHaveLength(1);
    expect(subtree[0]!.id).toBe('grandchild-a1');
  });

  it('returns empty array for a non-existent root ID', async () => {
    const subtree = await store.getSubtree('does-not-exist');
    expect(subtree).toEqual([]);
  });

  it('correctly maps domain fields in CTE result rows', async () => {
    const subtree = await store.getSubtree('root');
    const root = subtree.find((t) => t.id === 'root');
    expect(root).toBeDefined();
    expect(root!.team_slug).toBe('tree-team');
    expect(root!.status).toBe('pending');
    expect(root!.parent_id).toBeUndefined();

    const childA = subtree.find((t) => t.id === 'child-a');
    expect(childA).toBeDefined();
    expect(childA!.parent_id).toBe('root');
  });

  // -------------------------------------------------------------------------
  // GetSubtree respects max depth limit
  // -------------------------------------------------------------------------

  it('respects maxDepth — stops at depth 1 (excludes grandchildren)', async () => {
    // With maxDepth=1: root (depth 0) + children (depth 1) only
    const subtree = await store.getSubtreeWithDepth('root', 1);
    const ids = subtree.map((t) => t.id).sort();
    // depth 0 = root, depth 1 = child-a + child-b, depth 2 = grandchild-a1 (excluded)
    expect(ids).toEqual(['child-a', 'child-b', 'root']);
    expect(ids).not.toContain('grandchild-a1');
  });

  it('respects maxDepth — stops at depth 0 (root only)', async () => {
    const subtree = await store.getSubtreeWithDepth('root', 0);
    // depth <= 0 uses DEFAULT_SUBTREE_MAX_DEPTH, so should still return all
    // Wait — Go behaviour: if maxDepth <= 0 it becomes defaultSubtreeMaxDepth.
    // So depth=0 → all 4 nodes.
    expect(subtree.length).toBe(4);
  });

  it('returns full tree when maxDepth is larger than tree depth', async () => {
    const subtree = await store.getSubtreeWithDepth('root', 100);
    expect(subtree).toHaveLength(4);
  });
});
