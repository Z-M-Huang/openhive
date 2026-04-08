/**
 * Vault Tool Handlers — unit tests.
 *
 * Tests the 4 handler functions (vaultSet, vaultGet, vaultList, vaultDelete).
 * Covers AC-2: is_secret enforcement.
 */

import { describe, it, expect, vi } from 'vitest';
import type { IVaultStore } from '../../domain/interfaces.js';
import type { VaultEntry } from '../../domain/types.js';
import { vaultSet } from './vault-set.js';
import { vaultGet } from './vault-get.js';
import { vaultList } from './vault-list.js';
import { vaultDelete } from './vault-delete.js';

// ── Mock factory ────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<VaultEntry> = {}): VaultEntry {
  return {
    id: 1,
    teamName: 'test-team',
    key: 'my-key',
    value: 'my-value',
    isSecret: false,
    updatedBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeMockStore(): { [K in keyof IVaultStore]: ReturnType<typeof vi.fn> } {
  return {
    set: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
    getSecrets: vi.fn(),
    removeByTeam: vi.fn(),
  };
}

// ── vault_set ───────────────────────────────────────────────────────────────

describe('vaultSet', () => {
  it('creates a new entry when key does not exist', () => {
    const store = makeMockStore();
    store.get.mockReturnValue(undefined);
    const entry = makeEntry();
    store.set.mockReturnValue(entry);

    const result = vaultSet(
      { key: 'my-key', value: 'my-value' },
      'test-team',
      { vaultStore: store as unknown as IVaultStore, log: vi.fn() },
    );

    expect(result.success).toBe(true);
    expect(result.entry).toBe(entry);
    expect(store.set).toHaveBeenCalledWith('test-team', 'my-key', 'my-value', false);
  });

  it('allows overwrite when existing entry is not a secret', () => {
    const store = makeMockStore();
    store.get.mockReturnValue(makeEntry({ isSecret: false }));
    const updated = makeEntry({ value: 'new-value' });
    store.set.mockReturnValue(updated);

    const result = vaultSet(
      { key: 'my-key', value: 'new-value' },
      'test-team',
      { vaultStore: store as unknown as IVaultStore, log: vi.fn() },
    );

    expect(result.success).toBe(true);
    expect(result.entry).toBe(updated);
  });

  it('rejects overwrite when existing entry is a secret', () => {
    const store = makeMockStore();
    store.get.mockReturnValue(makeEntry({ isSecret: true }));

    const result = vaultSet(
      { key: 'my-key', value: 'hack' },
      'test-team',
      { vaultStore: store as unknown as IVaultStore, log: vi.fn() },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('cannot overwrite system-managed secret');
    expect(store.set).not.toHaveBeenCalled();
  });

  it('logs vault_set on success', () => {
    const store = makeMockStore();
    store.get.mockReturnValue(undefined);
    store.set.mockReturnValue(makeEntry());
    const log = vi.fn();

    vaultSet({ key: 'k', value: 'v' }, 'team-a', { vaultStore: store as unknown as IVaultStore, log });

    expect(log).toHaveBeenCalledWith('vault_set', { team: 'team-a', key: 'k' });
  });
});

// ── vault_get ───────────────────────────────────────────────────────────────

describe('vaultGet', () => {
  it('returns value for existing key', () => {
    const store = makeMockStore();
    store.get.mockReturnValue(makeEntry({ value: 'secret-val' }));

    const result = vaultGet(
      { key: 'my-key' },
      'test-team',
      { vaultStore: store as unknown as IVaultStore, log: vi.fn() },
    );

    expect(result.success).toBe(true);
    expect(result.value).toBe('secret-val');
  });

  it('returns error for missing key', () => {
    const store = makeMockStore();
    store.get.mockReturnValue(undefined);

    const result = vaultGet(
      { key: 'nope' },
      'test-team',
      { vaultStore: store as unknown as IVaultStore, log: vi.fn() },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});

// ── vault_list ──────────────────────────────────────────────────────────────

describe('vaultList', () => {
  it('returns key+isSecret and includes value for non-secrets', () => {
    const store = makeMockStore();
    store.list.mockReturnValue([
      makeEntry({ key: 'public', value: 'pub-val', isSecret: false }),
    ]);

    const result = vaultList('test-team', { vaultStore: store as unknown as IVaultStore });

    expect(result).toEqual([{ key: 'public', isSecret: false, value: 'pub-val' }]);
  });

  it('omits value for secret entries', () => {
    const store = makeMockStore();
    store.list.mockReturnValue([
      makeEntry({ key: 'api-key', value: 'super-secret', isSecret: true }),
    ]);

    const result = vaultList('test-team', { vaultStore: store as unknown as IVaultStore });

    expect(result).toEqual([{ key: 'api-key', isSecret: true }]);
    expect(result[0]).not.toHaveProperty('value');
  });

  it('handles mixed entries correctly', () => {
    const store = makeMockStore();
    store.list.mockReturnValue([
      makeEntry({ key: 'note', value: 'hello', isSecret: false }),
      makeEntry({ key: 'token', value: 'hidden', isSecret: true }),
    ]);

    const result = vaultList('test-team', { vaultStore: store as unknown as IVaultStore });

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ key: 'note', isSecret: false, value: 'hello' });
    expect(result[1]).toEqual({ key: 'token', isSecret: true });
  });
});

// ── vault_delete ────────────────────────────────────────────────────────────

describe('vaultDelete', () => {
  it('deletes a non-secret entry', () => {
    const store = makeMockStore();
    store.get.mockReturnValue(makeEntry({ isSecret: false }));
    store.delete.mockReturnValue(true);

    const result = vaultDelete(
      { key: 'my-key' },
      'test-team',
      { vaultStore: store as unknown as IVaultStore },
    );

    expect(result.success).toBe(true);
    expect(result.deleted).toBe(true);
    expect(store.delete).toHaveBeenCalledWith('test-team', 'my-key');
  });

  it('rejects deletion of a secret entry', () => {
    const store = makeMockStore();
    store.get.mockReturnValue(makeEntry({ isSecret: true }));

    const result = vaultDelete(
      { key: 'api-key' },
      'test-team',
      { vaultStore: store as unknown as IVaultStore },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('cannot delete system-managed secret');
    expect(store.delete).not.toHaveBeenCalled();
  });

  it('returns deleted=false for nonexistent key', () => {
    const store = makeMockStore();
    store.get.mockReturnValue(undefined);

    const result = vaultDelete(
      { key: 'nope' },
      'test-team',
      { vaultStore: store as unknown as IVaultStore },
    );

    expect(result.success).toBe(true);
    expect(result.deleted).toBe(false);
  });
});
