/**
 * Tests for EscalationStoreImpl.
 *
 * Uses newInMemoryDB() so every test runs against a clean, isolated SQLite
 * database. The store is created WITHOUT a separate reader — this causes it
 * to use db.writer for both reads and writes, ensuring test visibility.
 *
 * Covers:
 *   - Create and retrieve an escalation
 *   - Get throws NotFoundError for missing ID
 *   - Update modifies fields and returns success
 *   - Update throws NotFoundError for missing escalation
 *   - ListByAgent filters correctly
 *   - ListByStatus filters by status integer mapping
 *   - ListByTask filters by task ID
 *   - Status round-trip (all four status values)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { newInMemoryDB } from './db.js';
import { newEscalationStore } from './escalation-store.js';
import { NotFoundError } from '../domain/errors.js';
import type { DB } from './db.js';
import type { EscalationStoreImpl } from './escalation-store.js';
import type { Escalation, EscalationStatus } from '../domain/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let db: DB;
let store: EscalationStoreImpl;

beforeEach(() => {
  db = newInMemoryDB();
  store = newEscalationStore(db);
});

afterEach(() => {
  db.close();
});

function makeEscalation(overrides: Partial<Escalation> & { id: string }): Escalation {
  return {
    id: overrides.id,
    correlation_id: overrides.correlation_id ?? `corr-${overrides.id}`,
    task_id: overrides.task_id ?? 'task-1',
    from_aid: overrides.from_aid ?? 'aid-from-001',
    to_aid: overrides.to_aid ?? 'aid-to-002',
    source_team: overrides.source_team ?? 'tid-src',
    destination_team: overrides.destination_team ?? 'tid-dest',
    escalation_level: overrides.escalation_level ?? 1,
    reason: overrides.reason ?? 'need help',
    context: overrides.context,
    status: overrides.status ?? 'pending',
    resolution: overrides.resolution,
    created_at: overrides.created_at ?? new Date(1_000_000),
    updated_at: overrides.updated_at ?? new Date(1_000_000),
    resolved_at: overrides.resolved_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// Create and retrieve
// ---------------------------------------------------------------------------

describe('create and get', () => {
  it('creates an escalation and retrieves it by ID', async () => {
    const esc = makeEscalation({ id: 'esc-1' });
    await store.create(esc);

    const retrieved = await store.get('esc-1');
    expect(retrieved.id).toBe('esc-1');
    expect(retrieved.task_id).toBe('task-1');
    expect(retrieved.from_aid).toBe('aid-from-001');
    expect(retrieved.to_aid).toBe('aid-to-002');
    expect(retrieved.reason).toBe('need help');
    expect(retrieved.status).toBe('pending');
    expect(retrieved.resolved_at).toBeNull();
  });

  it('round-trips all fields including optional ones and new chain fields', async () => {
    const esc = makeEscalation({
      id: 'esc-full',
      correlation_id: 'corr-chain-1',
      task_id: 'task-42',
      from_aid: 'aid-a',
      to_aid: 'aid-b',
      source_team: 'tid-team-a1',
      destination_team: 'tid-team-a',
      escalation_level: 2,
      reason: 'stuck on subtask',
      context: 'detailed context here',
      status: 'resolved',
      resolution: 'fixed the issue',
      created_at: new Date(2_000_000),
      updated_at: new Date(3_000_000),
      resolved_at: new Date(4_000_000),
    });
    await store.create(esc);

    const retrieved = await store.get('esc-full');
    expect(retrieved.correlation_id).toBe('corr-chain-1');
    expect(retrieved.source_team).toBe('tid-team-a1');
    expect(retrieved.destination_team).toBe('tid-team-a');
    expect(retrieved.escalation_level).toBe(2);
    expect(retrieved.context).toBe('detailed context here');
    expect(retrieved.resolution).toBe('fixed the issue');
    expect(retrieved.resolved_at!.getTime()).toBe(4_000_000);
  });

  it('returns undefined for context and resolution when not set', async () => {
    const esc = makeEscalation({ id: 'esc-noopt' });
    await store.create(esc);

    const retrieved = await store.get('esc-noopt');
    expect(retrieved.context).toBeUndefined();
    expect(retrieved.resolution).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Get throws NotFoundError
// ---------------------------------------------------------------------------

describe('get — not found', () => {
  it('throws NotFoundError when the escalation does not exist', async () => {
    await expect(store.get('esc-missing')).rejects.toThrow(NotFoundError);
  });

  it('includes the resource and ID in the error', async () => {
    let caught: NotFoundError | undefined;
    try {
      await store.get('esc-gone');
    } catch (e) {
      if (e instanceof NotFoundError) caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught!.resource).toBe('escalation');
    expect(caught!.id).toBe('esc-gone');
  });
});

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

describe('update', () => {
  it('updates fields on an existing escalation', async () => {
    const esc = makeEscalation({ id: 'esc-upd' });
    await store.create(esc);

    const updated: Escalation = {
      ...esc,
      status: 'resolved',
      resolution: 'all done',
      updated_at: new Date(5_000_000),
      resolved_at: new Date(5_000_000),
    };
    await store.update(updated);

    const retrieved = await store.get('esc-upd');
    expect(retrieved.status).toBe('resolved');
    expect(retrieved.resolution).toBe('all done');
    expect(retrieved.updated_at.getTime()).toBe(5_000_000);
    expect(retrieved.resolved_at!.getTime()).toBe(5_000_000);
  });

  it('throws NotFoundError when updating a non-existent escalation', async () => {
    const esc = makeEscalation({ id: 'esc-nonexist' });
    await expect(store.update(esc)).rejects.toThrow(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Status round-trip
// ---------------------------------------------------------------------------

describe('status mapping', () => {
  const statuses: EscalationStatus[] = ['pending', 'resolved', 'rejected', 'timed_out'];

  for (const status of statuses) {
    it(`round-trips status "${status}" correctly`, async () => {
      const esc = makeEscalation({ id: `esc-status-${status}`, status });
      await store.create(esc);

      const retrieved = await store.get(`esc-status-${status}`);
      expect(retrieved.status).toBe(status);
    });
  }
});

// ---------------------------------------------------------------------------
// ListByAgent
// ---------------------------------------------------------------------------

describe('listByAgent', () => {
  it('returns escalations from the given agent ordered by created_at DESC', async () => {
    await store.create(
      makeEscalation({ id: 'esc-a1', from_aid: 'aid-a', created_at: new Date(1_000) }),
    );
    await store.create(
      makeEscalation({ id: 'esc-a2', from_aid: 'aid-a', created_at: new Date(3_000) }),
    );
    await store.create(
      makeEscalation({ id: 'esc-b1', from_aid: 'aid-b', created_at: new Date(2_000) }),
    );

    const result = await store.listByAgent('aid-a');
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe('esc-a2');
    expect(result[1]!.id).toBe('esc-a1');
  });

  it('returns empty array when no escalations exist for the agent', async () => {
    const result = await store.listByAgent('aid-none');
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ListByStatus
// ---------------------------------------------------------------------------

describe('listByStatus', () => {
  it('filters escalations by status', async () => {
    await store.create(
      makeEscalation({ id: 'esc-p1', status: 'pending', created_at: new Date(1_000) }),
    );
    await store.create(
      makeEscalation({ id: 'esc-r1', status: 'resolved', created_at: new Date(2_000) }),
    );
    await store.create(
      makeEscalation({ id: 'esc-p2', status: 'pending', created_at: new Date(3_000) }),
    );

    const pending = await store.listByStatus('pending');
    expect(pending).toHaveLength(2);
    expect(pending[0]!.id).toBe('esc-p2');
    expect(pending[1]!.id).toBe('esc-p1');

    const resolved = await store.listByStatus('resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.id).toBe('esc-r1');
  });

  it('returns empty array for unused status', async () => {
    await store.create(makeEscalation({ id: 'esc-only-p', status: 'pending' }));
    const rejected = await store.listByStatus('rejected');
    expect(rejected).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ListByCorrelation
// ---------------------------------------------------------------------------

describe('listByCorrelation', () => {
  it('returns escalations matching correlation_id ordered by created_at DESC', async () => {
    await store.create(
      makeEscalation({ id: 'esc-c1', correlation_id: 'corr-x', created_at: new Date(1_000) }),
    );
    await store.create(
      makeEscalation({ id: 'esc-c2', correlation_id: 'corr-x', created_at: new Date(3_000) }),
    );
    await store.create(
      makeEscalation({ id: 'esc-c3', correlation_id: 'corr-y', created_at: new Date(2_000) }),
    );

    const result = await store.listByCorrelation('corr-x');
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe('esc-c2');
    expect(result[1]!.id).toBe('esc-c1');
  });

  it('returns empty array for unknown correlation_id', async () => {
    const result = await store.listByCorrelation('corr-none');
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ListByTask
// ---------------------------------------------------------------------------

describe('listByTask', () => {
  it('returns escalations for the given task ordered by created_at DESC', async () => {
    await store.create(
      makeEscalation({ id: 'esc-t1', task_id: 'task-x', created_at: new Date(1_000) }),
    );
    await store.create(
      makeEscalation({ id: 'esc-t2', task_id: 'task-x', created_at: new Date(3_000) }),
    );
    await store.create(
      makeEscalation({ id: 'esc-t3', task_id: 'task-y', created_at: new Date(2_000) }),
    );

    const result = await store.listByTask('task-x');
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe('esc-t2');
    expect(result[1]!.id).toBe('esc-t1');
  });

  it('returns empty array for non-existent task', async () => {
    const result = await store.listByTask('task-none');
    expect(result).toEqual([]);
  });
});
