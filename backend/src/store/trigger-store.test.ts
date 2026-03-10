/**
 * Tests for TriggerStoreImpl.
 *
 * Uses newInMemoryDB() so every test runs against a clean, isolated SQLite
 * database. The store is created WITHOUT a separate reader — this causes it
 * to use db.writer for both reads and writes, ensuring test visibility.
 *
 * Covers:
 *   - Create and retrieve a trigger
 *   - Get throws NotFoundError for missing ID
 *   - Update modifies fields and returns success
 *   - Update throws NotFoundError for missing trigger
 *   - Delete removes a trigger
 *   - ListByTeam returns triggers ordered by created_at DESC
 *   - ListEnabled returns only enabled triggers
 *   - ListDue returns enabled triggers whose next_run_at <= now
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { newInMemoryDB } from './db.js';
import { newTriggerStore } from './trigger-store.js';
import { NotFoundError } from '../domain/errors.js';
import type { DB } from './db.js';
import type { TriggerStoreImpl } from './trigger-store.js';
import type { Trigger } from '../domain/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let db: DB;
let store: TriggerStoreImpl;

beforeEach(() => {
  db = newInMemoryDB();
  store = newTriggerStore(db);
});

afterEach(() => {
  db.close();
});

function makeTrigger(overrides: Partial<Trigger> & { id: string }): Trigger {
  return {
    id: overrides.id,
    name: overrides.name ?? 'test-trigger',
    team_slug: overrides.team_slug ?? 'test-team',
    agent_aid: overrides.agent_aid ?? 'aid-agent-001',
    schedule: overrides.schedule ?? '0 0/5 * * *',
    prompt: overrides.prompt ?? 'run health check',
    enabled: overrides.enabled ?? true,
    type: overrides.type ?? 'cron',
    webhook_path: overrides.webhook_path ?? '',
    last_run_at: overrides.last_run_at ?? null,
    next_run_at: overrides.next_run_at ?? null,
    created_at: overrides.created_at ?? new Date(1_000_000),
    updated_at: overrides.updated_at ?? new Date(1_000_000),
  };
}

// ---------------------------------------------------------------------------
// Create and retrieve
// ---------------------------------------------------------------------------

describe('create and get', () => {
  it('creates a trigger and retrieves it by ID', async () => {
    const trig = makeTrigger({ id: 'trig-1' });
    await store.create(trig);

    const retrieved = await store.get('trig-1');
    expect(retrieved.id).toBe('trig-1');
    expect(retrieved.name).toBe('test-trigger');
    expect(retrieved.team_slug).toBe('test-team');
    expect(retrieved.agent_aid).toBe('aid-agent-001');
    expect(retrieved.schedule).toBe('0 0/5 * * *');
    expect(retrieved.prompt).toBe('run health check');
    expect(retrieved.enabled).toBe(true);
    expect(retrieved.last_run_at).toBeNull();
    expect(retrieved.next_run_at).toBeNull();
  });

  it('round-trips all fields including timestamps', async () => {
    const trig = makeTrigger({
      id: 'trig-full',
      name: 'daily-report',
      team_slug: 'analytics',
      agent_aid: 'aid-reporter',
      schedule: '0 9 * * 1-5',
      prompt: 'generate daily report',
      enabled: true,
      last_run_at: new Date(2_000_000),
      next_run_at: new Date(3_000_000),
      created_at: new Date(1_000_000),
      updated_at: new Date(1_500_000),
    });
    await store.create(trig);

    const retrieved = await store.get('trig-full');
    expect(retrieved.name).toBe('daily-report');
    expect(retrieved.team_slug).toBe('analytics');
    expect(retrieved.last_run_at!.getTime()).toBe(2_000_000);
    expect(retrieved.next_run_at!.getTime()).toBe(3_000_000);
  });

  it('stores enabled=false correctly', async () => {
    const trig = makeTrigger({ id: 'trig-disabled', enabled: false });
    await store.create(trig);

    const retrieved = await store.get('trig-disabled');
    expect(retrieved.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Get throws NotFoundError
// ---------------------------------------------------------------------------

describe('get — not found', () => {
  it('throws NotFoundError when the trigger does not exist', async () => {
    await expect(store.get('trig-missing')).rejects.toThrow(NotFoundError);
  });

  it('includes the resource and ID in the error', async () => {
    let caught: NotFoundError | undefined;
    try {
      await store.get('trig-gone');
    } catch (e) {
      if (e instanceof NotFoundError) caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught!.resource).toBe('trigger');
    expect(caught!.id).toBe('trig-gone');
  });
});

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

describe('update', () => {
  it('updates fields on an existing trigger', async () => {
    const trig = makeTrigger({ id: 'trig-upd' });
    await store.create(trig);

    const updated: Trigger = {
      ...trig,
      name: 'updated-trigger',
      schedule: '0 0 * * *',
      enabled: false,
      last_run_at: new Date(5_000_000),
      next_run_at: new Date(6_000_000),
      updated_at: new Date(5_000_000),
    };
    await store.update(updated);

    const retrieved = await store.get('trig-upd');
    expect(retrieved.name).toBe('updated-trigger');
    expect(retrieved.schedule).toBe('0 0 * * *');
    expect(retrieved.enabled).toBe(false);
    expect(retrieved.last_run_at!.getTime()).toBe(5_000_000);
    expect(retrieved.next_run_at!.getTime()).toBe(6_000_000);
  });

  it('throws NotFoundError when updating a non-existent trigger', async () => {
    const trig = makeTrigger({ id: 'trig-nonexist' });
    await expect(store.update(trig)).rejects.toThrow(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

describe('delete', () => {
  it('removes a trigger by ID', async () => {
    await store.create(makeTrigger({ id: 'trig-del' }));
    await store.delete('trig-del');

    await expect(store.get('trig-del')).rejects.toThrow(NotFoundError);
  });

  it('does not throw when deleting a non-existent ID', async () => {
    await expect(store.delete('trig-ghost')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ListByTeam
// ---------------------------------------------------------------------------

describe('listByTeam', () => {
  it('returns triggers for the given team ordered by created_at DESC', async () => {
    await store.create(
      makeTrigger({ id: 'trig-t1', team_slug: 'team-a', created_at: new Date(1_000) }),
    );
    await store.create(
      makeTrigger({ id: 'trig-t2', team_slug: 'team-a', created_at: new Date(3_000) }),
    );
    await store.create(
      makeTrigger({ id: 'trig-t3', team_slug: 'team-b', created_at: new Date(2_000) }),
    );

    const result = await store.listByTeam('team-a');
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe('trig-t2');
    expect(result[1]!.id).toBe('trig-t1');
  });

  it('returns empty array for team with no triggers', async () => {
    const result = await store.listByTeam('team-none');
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ListEnabled
// ---------------------------------------------------------------------------

describe('listEnabled', () => {
  it('returns only enabled triggers', async () => {
    await store.create(
      makeTrigger({ id: 'trig-on1', enabled: true, created_at: new Date(1_000) }),
    );
    await store.create(
      makeTrigger({ id: 'trig-off', enabled: false, created_at: new Date(2_000) }),
    );
    await store.create(
      makeTrigger({ id: 'trig-on2', enabled: true, created_at: new Date(3_000) }),
    );

    const result = await store.listEnabled();
    expect(result).toHaveLength(2);
    const ids = result.map((t) => t.id);
    expect(ids).toContain('trig-on1');
    expect(ids).toContain('trig-on2');
    expect(ids).not.toContain('trig-off');
  });

  it('returns empty array when no triggers are enabled', async () => {
    await store.create(makeTrigger({ id: 'trig-d', enabled: false }));
    const result = await store.listEnabled();
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ListDue
// ---------------------------------------------------------------------------

describe('listDue', () => {
  it('returns enabled triggers whose next_run_at is at or before now', async () => {
    const now = new Date(5_000);

    await store.create(
      makeTrigger({
        id: 'trig-due',
        enabled: true,
        next_run_at: new Date(3_000),
      }),
    );
    await store.create(
      makeTrigger({
        id: 'trig-exact',
        enabled: true,
        next_run_at: new Date(5_000),
      }),
    );
    await store.create(
      makeTrigger({
        id: 'trig-future',
        enabled: true,
        next_run_at: new Date(10_000),
      }),
    );
    await store.create(
      makeTrigger({
        id: 'trig-disabled-due',
        enabled: false,
        next_run_at: new Date(1_000),
      }),
    );

    const result = await store.listDue(now);
    expect(result).toHaveLength(2);
    // Ordered by next_run_at ASC
    expect(result[0]!.id).toBe('trig-due');
    expect(result[1]!.id).toBe('trig-exact');
  });

  it('excludes triggers with null next_run_at', async () => {
    await store.create(
      makeTrigger({ id: 'trig-null', enabled: true, next_run_at: null }),
    );

    const result = await store.listDue(new Date(999_999));
    expect(result).toEqual([]);
  });

  it('returns empty array when no triggers are due', async () => {
    await store.create(
      makeTrigger({ id: 'trig-later', enabled: true, next_run_at: new Date(100_000) }),
    );

    const result = await store.listDue(new Date(1_000));
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Webhook trigger round-trip
// ---------------------------------------------------------------------------

describe('webhook trigger round-trip', () => {
  it('creates a webhook trigger and retrieves all fields correctly', async () => {
    const trig = makeTrigger({
      id: 'trig-webhook-1',
      name: 'deploy-hook',
      type: 'webhook',
      webhook_path: 'my-hook',
      schedule: '',
    });
    await store.create(trig);

    const retrieved = await store.get('trig-webhook-1');
    expect(retrieved.type).toBe('webhook');
    expect(retrieved.webhook_path).toBe('my-hook');
    expect(retrieved.schedule).toBe('');
    expect(retrieved.name).toBe('deploy-hook');
  });

  it('round-trips type and webhook_path through update', async () => {
    const trig = makeTrigger({
      id: 'trig-webhook-upd',
      type: 'webhook',
      webhook_path: 'original-path',
    });
    await store.create(trig);

    const updated: Trigger = {
      ...trig,
      webhook_path: 'updated-path',
      updated_at: new Date(5_000_000),
    };
    await store.update(updated);

    const retrieved = await store.get('trig-webhook-upd');
    expect(retrieved.type).toBe('webhook');
    expect(retrieved.webhook_path).toBe('updated-path');
  });

  it('defaults type to "cron" when not specified', async () => {
    const trig = makeTrigger({ id: 'trig-default-type' });
    await store.create(trig);

    const retrieved = await store.get('trig-default-type');
    expect(retrieved.type).toBe('cron');
    expect(retrieved.webhook_path).toBe('');
  });
});
