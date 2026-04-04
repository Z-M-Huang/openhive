/**
 * TopicStore unit tests — in-memory SQLite via Drizzle.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, createTables } from '../database.js';
import type { DatabaseInstance } from '../database.js';
import { TopicStore } from './topic-store.js';
import type { TopicEntry } from '../../domain/types.js';

function makeTopic(overrides: Partial<TopicEntry> & { id: string; channelId: string }): TopicEntry {
  const now = new Date().toISOString();
  return {
    name: 'test-topic',
    description: '',
    state: 'active',
    createdAt: now,
    lastActivity: now,
    ...overrides,
  };
}

describe('TopicStore', () => {
  let instance: DatabaseInstance;
  let store: TopicStore;

  beforeEach(() => {
    instance = createDatabase(':memory:');
    createTables(instance.raw);
    store = new TopicStore(instance.db);
  });

  afterEach(() => {
    instance.raw.close();
  });

  it('create + getById round-trips a topic', () => {
    const topic = makeTopic({ id: 't-001', channelId: 'ch-1', name: 'billing', description: 'Billing questions' });
    store.create(topic);

    const result = store.getById('t-001');
    expect(result).toBeDefined();
    expect(result?.id).toBe('t-001');
    expect(result?.channelId).toBe('ch-1');
    expect(result?.name).toBe('billing');
    expect(result?.description).toBe('Billing questions');
    expect(result?.state).toBe('active');
  });

  it('getById returns undefined for nonexistent id', () => {
    expect(store.getById('nope')).toBeUndefined();
  });

  it('getByChannel returns all topics for a channel', () => {
    store.create(makeTopic({ id: 't-1', channelId: 'ch-A', name: 'topic-1' }));
    store.create(makeTopic({ id: 't-2', channelId: 'ch-A', name: 'topic-2' }));
    store.create(makeTopic({ id: 't-3', channelId: 'ch-B', name: 'topic-3' }));

    const results = store.getByChannel('ch-A');
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.name).sort()).toEqual(['topic-1', 'topic-2']);
  });

  it('getActiveByChannel filters by state=active', () => {
    store.create(makeTopic({ id: 't-1', channelId: 'ch-1', state: 'active' }));
    store.create(makeTopic({ id: 't-2', channelId: 'ch-1', state: 'idle' }));
    store.create(makeTopic({ id: 't-3', channelId: 'ch-1', state: 'done' }));

    const active = store.getActiveByChannel('ch-1');
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe('t-1');
  });

  it('getIdleByChannel filters by state=idle', () => {
    store.create(makeTopic({ id: 't-1', channelId: 'ch-1', state: 'active' }));
    store.create(makeTopic({ id: 't-2', channelId: 'ch-1', state: 'idle' }));
    store.create(makeTopic({ id: 't-3', channelId: 'ch-1', state: 'idle' }));

    const idle = store.getIdleByChannel('ch-1');
    expect(idle).toHaveLength(2);
    expect(idle.map((t) => t.id).sort()).toEqual(['t-2', 't-3']);
  });

  it('updateState transitions active → idle → done', () => {
    store.create(makeTopic({ id: 't-1', channelId: 'ch-1', state: 'active' }));

    store.updateState('t-1', 'idle');
    expect(store.getById('t-1')?.state).toBe('idle');

    store.updateState('t-1', 'done');
    expect(store.getById('t-1')?.state).toBe('done');
  });

  it('touchActivity updates the lastActivity timestamp', () => {
    const old = '2020-01-01T00:00:00.000Z';
    store.create(makeTopic({ id: 't-1', channelId: 'ch-1', lastActivity: old }));

    store.touchActivity('t-1');

    const updated = store.getById('t-1');
    expect(updated?.lastActivity).not.toBe(old);
    expect(new Date(updated!.lastActivity).getTime()).toBeGreaterThan(new Date(old).getTime());
  });

  it('markAllIdle marks only active topics as idle and returns count', () => {
    store.create(makeTopic({ id: 't-1', channelId: 'ch-1', state: 'active' }));
    store.create(makeTopic({ id: 't-2', channelId: 'ch-1', state: 'active' }));
    store.create(makeTopic({ id: 't-3', channelId: 'ch-1', state: 'idle' }));
    store.create(makeTopic({ id: 't-4', channelId: 'ch-1', state: 'done' }));

    const count = store.markAllIdle();
    expect(count).toBe(2);

    expect(store.getById('t-1')?.state).toBe('idle');
    expect(store.getById('t-2')?.state).toBe('idle');
    expect(store.getById('t-3')?.state).toBe('idle');
    expect(store.getById('t-4')?.state).toBe('done');
  });

  it('markAllIdle with channelId scopes to that channel', () => {
    store.create(makeTopic({ id: 't-1', channelId: 'ch-A', state: 'active' }));
    store.create(makeTopic({ id: 't-2', channelId: 'ch-B', state: 'active' }));

    const count = store.markAllIdle('ch-A');
    expect(count).toBe(1);

    expect(store.getById('t-1')?.state).toBe('idle');
    expect(store.getById('t-2')?.state).toBe('active');
  });
});
