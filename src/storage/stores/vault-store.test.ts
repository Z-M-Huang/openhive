/**
 * VaultStore unit tests — in-memory SQLite via Drizzle.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, createTables } from '../database.js';
import type { DatabaseInstance } from '../database.js';
import { VaultStore } from './vault-store.js';

describe('VaultStore', () => {
  let instance: DatabaseInstance;
  let store: VaultStore;

  beforeEach(() => {
    instance = createDatabase(':memory:');
    createTables(instance.raw);
    store = new VaultStore(instance.db);
  });

  afterEach(() => {
    instance.raw.close();
  });

  // -- set + get round-trip ------------------------------------------------

  it('set + get round-trips a non-secret entry', () => {
    const entry = store.set('team-a', 'API_URL', 'https://example.com', false, 'admin');

    expect(entry.teamName).toBe('team-a');
    expect(entry.key).toBe('API_URL');
    expect(entry.value).toBe('https://example.com');
    expect(entry.isSecret).toBe(false);
    expect(entry.updatedBy).toBe('admin');

    const fetched = store.get('team-a', 'API_URL');
    expect(fetched).toEqual(entry);
  });

  it('set + get round-trips a secret entry', () => {
    const entry = store.set('team-a', 'TOKEN', 'sk-abc123', true);

    expect(entry.isSecret).toBe(true);
    expect(entry.updatedBy).toBeNull();
  });

  it('get returns undefined for nonexistent entry', () => {
    expect(store.get('team-a', 'missing')).toBeUndefined();
  });

  // -- upsert behavior -----------------------------------------------------

  it('set upserts on duplicate team+key', () => {
    store.set('team-a', 'KEY', 'v1', false, 'alice');
    const updated = store.set('team-a', 'KEY', 'v2', true, 'bob');

    expect(updated.value).toBe('v2');
    expect(updated.isSecret).toBe(true);
    expect(updated.updatedBy).toBe('bob');

    // Should be exactly one entry, not two
    const all = store.list('team-a');
    expect(all).toHaveLength(1);
  });

  // -- list ----------------------------------------------------------------

  it('list returns all entries for a team', () => {
    store.set('team-a', 'K1', 'v1', false);
    store.set('team-a', 'K2', 'v2', true);
    store.set('team-b', 'K3', 'v3', false);

    const teamA = store.list('team-a');
    expect(teamA).toHaveLength(2);
    expect(teamA.map((e) => e.key).sort()).toEqual(['K1', 'K2']);
  });

  it('list returns empty array for unknown team', () => {
    expect(store.list('nobody')).toEqual([]);
  });

  // -- delete --------------------------------------------------------------

  it('delete removes an entry and returns true', () => {
    store.set('team-a', 'KEY', 'val', false);
    expect(store.delete('team-a', 'KEY')).toBe(true);
    expect(store.get('team-a', 'KEY')).toBeUndefined();
  });

  it('delete returns false for nonexistent entry', () => {
    expect(store.delete('team-a', 'nope')).toBe(false);
  });

  // -- getSecrets ----------------------------------------------------------

  it('getSecrets returns only is_secret=1 entries', () => {
    store.set('team-a', 'PUBLIC', 'pub-val', false);
    store.set('team-a', 'SECRET1', 's1', true);
    store.set('team-a', 'SECRET2', 's2', true);

    const secrets = store.getSecrets('team-a');
    expect(secrets).toHaveLength(2);
    expect(secrets.every((e) => e.isSecret)).toBe(true);
  });

  it('getSecrets returns empty array when no secrets exist', () => {
    store.set('team-a', 'PUBLIC', 'val', false);
    expect(store.getSecrets('team-a')).toEqual([]);
  });

  // -- removeByTeam --------------------------------------------------------

  it('removeByTeam deletes all entries for a team', () => {
    store.set('team-a', 'K1', 'v1', false);
    store.set('team-a', 'K2', 'v2', true);
    store.set('team-b', 'K3', 'v3', false);

    store.removeByTeam('team-a');

    expect(store.list('team-a')).toEqual([]);
    expect(store.list('team-b')).toHaveLength(1);
  });

  it('removeByTeam is a no-op for unknown team', () => {
    store.set('team-a', 'KEY', 'val', false);
    store.removeByTeam('ghost');
    expect(store.list('team-a')).toHaveLength(1);
  });
});
