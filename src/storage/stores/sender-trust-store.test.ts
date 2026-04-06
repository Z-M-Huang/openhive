/**
 * SenderTrustStore unit tests — in-memory SQLite via Drizzle.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, createTables } from '../database.js';
import type { DatabaseInstance } from '../database.js';
import { SenderTrustStore } from './sender-trust-store.js';
import type { SenderTrustRecord } from '../../domain/interfaces.js';

function makeRecord(overrides: Partial<SenderTrustRecord> & { senderId: string }): SenderTrustRecord {
  const { senderId, ...rest } = overrides;
  return {
    channelType: 'discord',
    senderId,
    trustLevel: 'trusted',
    grantedBy: 'admin',
    createdAt: new Date().toISOString(),
    ...rest,
  };
}

describe('SenderTrustStore', () => {
  let instance: DatabaseInstance;
  let store: SenderTrustStore;

  beforeEach(() => {
    instance = createDatabase(':memory:');
    createTables(instance.raw);
    store = new SenderTrustStore(instance.db);
  });

  afterEach(() => {
    instance.raw.close();
  });

  // ── add + get ───────────────────────────────────────────────────────────

  it('add + get round-trips a global record (no channelId)', () => {
    const rec = makeRecord({ senderId: 'user-1' });
    store.add(rec);

    const result = store.get('discord', 'user-1');
    expect(result).toBeDefined();
    expect(result?.channelType).toBe('discord');
    expect(result?.senderId).toBe('user-1');
    expect(result?.trustLevel).toBe('trusted');
    expect(result?.grantedBy).toBe('admin');
    expect(result?.channelId).toBeUndefined();
  });

  it('add + get round-trips a channel-scoped record', () => {
    const rec = makeRecord({ senderId: 'user-2', channelId: 'ch-100' });
    store.add(rec);

    const result = store.get('discord', 'user-2', 'ch-100');
    expect(result).toBeDefined();
    expect(result?.channelId).toBe('ch-100');
    expect(result?.senderId).toBe('user-2');
  });

  it('get returns undefined for nonexistent record', () => {
    expect(store.get('discord', 'nobody')).toBeUndefined();
  });

  it('get distinguishes global from channel-scoped records', () => {
    store.add(makeRecord({ senderId: 'user-3' }));
    store.add(makeRecord({ senderId: 'user-3', channelId: 'ch-50', trustLevel: 'denied' }));

    const global = store.get('discord', 'user-3');
    expect(global?.trustLevel).toBe('trusted');
    expect(global?.channelId).toBeUndefined();

    const scoped = store.get('discord', 'user-3', 'ch-50');
    expect(scoped?.trustLevel).toBe('denied');
    expect(scoped?.channelId).toBe('ch-50');
  });

  // ── upsert behavior ─────────────────────────────────────────────────────

  it('add upserts on conflict (same channelType + channelId + senderId)', () => {
    store.add(makeRecord({ senderId: 'user-4', trustLevel: 'trusted', grantedBy: 'admin' }));
    store.add(makeRecord({ senderId: 'user-4', trustLevel: 'denied', grantedBy: 'moderator' }));

    const result = store.get('discord', 'user-4');
    expect(result?.trustLevel).toBe('denied');
    expect(result?.grantedBy).toBe('moderator');

    // Should be exactly one record, not two
    const all = store.list('discord');
    expect(all).toHaveLength(1);
  });

  // ── remove ──────────────────────────────────────────────────────────────

  it('remove deletes a global record', () => {
    store.add(makeRecord({ senderId: 'user-5' }));
    expect(store.get('discord', 'user-5')).toBeDefined();

    store.remove('discord', 'user-5');
    expect(store.get('discord', 'user-5')).toBeUndefined();
  });

  it('remove deletes a channel-scoped record without affecting global', () => {
    store.add(makeRecord({ senderId: 'user-6' }));
    store.add(makeRecord({ senderId: 'user-6', channelId: 'ch-77' }));

    store.remove('discord', 'user-6', 'ch-77');

    expect(store.get('discord', 'user-6', 'ch-77')).toBeUndefined();
    expect(store.get('discord', 'user-6')).toBeDefined();
  });

  it('remove is a no-op for nonexistent record', () => {
    // Should not throw
    store.remove('discord', 'ghost');
    expect(store.list()).toHaveLength(0);
  });

  // ── list ────────────────────────────────────────────────────────────────

  it('list returns all records when called with no filters', () => {
    store.add(makeRecord({ senderId: 'u-1', channelType: 'discord' }));
    store.add(makeRecord({ senderId: 'u-2', channelType: 'slack' }));
    store.add(makeRecord({ senderId: 'u-3', channelType: 'discord', trustLevel: 'denied' }));

    const all = store.list();
    expect(all).toHaveLength(3);
  });

  it('list filters by channelType', () => {
    store.add(makeRecord({ senderId: 'u-1', channelType: 'discord' }));
    store.add(makeRecord({ senderId: 'u-2', channelType: 'slack' }));

    const discordOnly = store.list('discord');
    expect(discordOnly).toHaveLength(1);
    expect(discordOnly[0]?.channelType).toBe('discord');
  });

  it('list filters by trustLevel', () => {
    store.add(makeRecord({ senderId: 'u-1', trustLevel: 'trusted' }));
    store.add(makeRecord({ senderId: 'u-2', trustLevel: 'denied' }));

    const denied = store.list(undefined, 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]?.trustLevel).toBe('denied');
  });

  it('list filters by both channelType and trustLevel', () => {
    store.add(makeRecord({ senderId: 'u-1', channelType: 'discord', trustLevel: 'trusted' }));
    store.add(makeRecord({ senderId: 'u-2', channelType: 'discord', trustLevel: 'denied' }));
    store.add(makeRecord({ senderId: 'u-3', channelType: 'slack', trustLevel: 'denied' }));

    const result = store.list('discord', 'denied');
    expect(result).toHaveLength(1);
    expect(result[0]?.senderId).toBe('u-2');
  });

  it('list returns empty array when nothing matches', () => {
    store.add(makeRecord({ senderId: 'u-1', channelType: 'discord' }));
    expect(store.list('telegram')).toHaveLength(0);
  });
});
