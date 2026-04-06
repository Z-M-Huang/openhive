/**
 * TrustAuditStore unit tests — in-memory SQLite via Drizzle.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, createTables } from '../database.js';
import type { DatabaseInstance } from '../database.js';
import { TrustAuditStore } from './trust-audit-store.js';
import type { TrustAuditEntry } from '../../domain/interfaces.js';

function makeEntry(overrides?: Partial<TrustAuditEntry>): TrustAuditEntry {
  return {
    channelType: 'discord',
    channelId: 'ch-1',
    senderId: 'user-1',
    decision: 'allowed',
    reason: 'trusted sender',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('TrustAuditStore', () => {
  let instance: DatabaseInstance;
  let store: TrustAuditStore;

  beforeEach(() => {
    instance = createDatabase(':memory:');
    createTables(instance.raw);
    store = new TrustAuditStore(instance.db);
  });

  afterEach(() => {
    instance.raw.close();
  });

  // ── log ─────────────────────────────────────────────────────────────────

  it('log inserts a record that can be queried back', () => {
    store.log(makeEntry({ senderId: 'user-a' }));

    const results = store.query({});
    expect(results).toHaveLength(1);
    expect(results[0]?.channelType).toBe('discord');
    expect(results[0]?.channelId).toBe('ch-1');
    expect(results[0]?.senderId).toBe('user-a');
    expect(results[0]?.decision).toBe('allowed');
    expect(results[0]?.reason).toBe('trusted sender');
  });

  it('log is append-only — multiple entries accumulate', () => {
    store.log(makeEntry({ senderId: 'user-1' }));
    store.log(makeEntry({ senderId: 'user-2' }));
    store.log(makeEntry({ senderId: 'user-1', decision: 'denied' }));

    const results = store.query({});
    expect(results).toHaveLength(3);
  });

  // ── query with no filters ──────────────────────────────────────────────

  it('query returns empty array when no entries exist', () => {
    const results = store.query({});
    expect(results).toHaveLength(0);
  });

  // ── query by decision ──────────────────────────────────────────────────

  it('query filters by decision', () => {
    store.log(makeEntry({ senderId: 'u-1', decision: 'allowed' }));
    store.log(makeEntry({ senderId: 'u-2', decision: 'denied' }));
    store.log(makeEntry({ senderId: 'u-3', decision: 'allowed' }));

    const denied = store.query({ decision: 'denied' });
    expect(denied).toHaveLength(1);
    expect(denied[0]?.senderId).toBe('u-2');
  });

  // ── query by senderId ──────────────────────────────────────────────────

  it('query filters by senderId', () => {
    store.log(makeEntry({ senderId: 'target', decision: 'allowed' }));
    store.log(makeEntry({ senderId: 'other', decision: 'denied' }));
    store.log(makeEntry({ senderId: 'target', decision: 'denied' }));

    const results = store.query({ senderId: 'target' });
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.senderId).toBe('target');
    }
  });

  // ── query by since ─────────────────────────────────────────────────────

  it('query filters by since (createdAt >= since)', () => {
    store.log(makeEntry({ senderId: 'old', createdAt: '2025-01-01T00:00:00.000Z' }));
    store.log(makeEntry({ senderId: 'new', createdAt: '2026-04-01T00:00:00.000Z' }));

    const results = store.query({ since: '2026-01-01T00:00:00.000Z' });
    expect(results).toHaveLength(1);
    expect(results[0]?.senderId).toBe('new');
  });

  // ── query with multiple filters ────────────────────────────────────────

  it('query combines decision + senderId filters', () => {
    store.log(makeEntry({ senderId: 'u-1', decision: 'allowed' }));
    store.log(makeEntry({ senderId: 'u-1', decision: 'denied' }));
    store.log(makeEntry({ senderId: 'u-2', decision: 'denied' }));

    const results = store.query({ decision: 'denied', senderId: 'u-1' });
    expect(results).toHaveLength(1);
    expect(results[0]?.senderId).toBe('u-1');
    expect(results[0]?.decision).toBe('denied');
  });

  // ── query limit ────────────────────────────────────────────────────────

  it('query respects limit', () => {
    for (let i = 0; i < 10; i++) {
      store.log(makeEntry({ senderId: `u-${i}` }));
    }

    const results = store.query({ limit: 3 });
    expect(results).toHaveLength(3);
  });

  it('query defaults to 100 limit', () => {
    // Insert fewer than 100 — all should be returned
    for (let i = 0; i < 5; i++) {
      store.log(makeEntry({ senderId: `u-${i}` }));
    }

    const results = store.query({});
    expect(results).toHaveLength(5);
  });

  // ── ordering ───────────────────────────────────────────────────────────

  it('query returns entries ordered by createdAt descending', () => {
    store.log(makeEntry({ senderId: 'first', createdAt: '2026-01-01T00:00:00.000Z' }));
    store.log(makeEntry({ senderId: 'second', createdAt: '2026-02-01T00:00:00.000Z' }));
    store.log(makeEntry({ senderId: 'third', createdAt: '2026-03-01T00:00:00.000Z' }));

    const results = store.query({});
    expect(results[0]?.senderId).toBe('third');
    expect(results[1]?.senderId).toBe('second');
    expect(results[2]?.senderId).toBe('first');
  });
});
