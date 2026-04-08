import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as yamlStringify } from 'yaml';
import { migrateCredentialsToVault } from './migration-vault.js';
import type { IVaultStore } from '../domain/interfaces.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `vault-mig-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function stubVaultStore(): IVaultStore & { calls: Array<{ teamName: string; key: string; value: string; isSecret: boolean; updatedBy?: string }> } {
  const calls: Array<{ teamName: string; key: string; value: string; isSecret: boolean; updatedBy?: string }> = [];
  return {
    calls,
    set(teamName, key, value, isSecret, updatedBy) {
      calls.push({ teamName, key, value, isSecret, updatedBy });
      return { id: 1, teamName, key, value, isSecret, updatedBy: updatedBy ?? null, createdAt: '', updatedAt: '' };
    },
    get: () => undefined,
    list: () => [],
    delete: () => false,
    getSecrets: () => [],
    removeByTeam: () => {},
  };
}

describe('migrateCredentialsToVault', () => {
  let runDir: string;
  let store: ReturnType<typeof stubVaultStore>;
  const log = vi.fn();

  beforeEach(() => {
    runDir = makeTmpDir();
    store = stubVaultStore();
    log.mockClear();
  });

  it('migrates credentials from config.yaml to vault as is_secret=1', () => {
    const teamDir = join(runDir, 'teams', 'alpha');
    mkdirSync(teamDir, { recursive: true });
    writeFileSync(join(teamDir, 'config.yaml'), yamlStringify({
      name: 'alpha',
      credentials: { SETTING_A: 'value-aaa', SETTING_B: 'value-bbb' },
    }));

    migrateCredentialsToVault(store, runDir, log);

    expect(store.calls).toHaveLength(2);
    expect(store.calls[0]).toEqual({ teamName: 'alpha', key: 'SETTING_A', value: 'value-aaa', isSecret: true, updatedBy: 'config-migration' });
    expect(store.calls[1]).toEqual({ teamName: 'alpha', key: 'SETTING_B', value: 'value-bbb', isSecret: true, updatedBy: 'config-migration' });
    expect(log).toHaveBeenCalledWith('Vault migration: migrated credentials from config.yaml', { count: 2 });
  });

  it('is idempotent — calling twice produces same vault state', () => {
    const teamDir = join(runDir, 'teams', 'beta');
    mkdirSync(teamDir, { recursive: true });
    writeFileSync(join(teamDir, 'config.yaml'), yamlStringify({
      name: 'beta',
      credentials: { MY_TOKEN: 'tok-xyz' },
    }));

    migrateCredentialsToVault(store, runDir, log);
    migrateCredentialsToVault(store, runDir, log);

    // set() called twice (once per run) — VaultStore.set() is upsert, so same result
    expect(store.calls).toHaveLength(2);
    expect(store.calls[0].key).toBe('MY_TOKEN');
    expect(store.calls[1].key).toBe('MY_TOKEN');
  });

  it('skips teams without credentials', () => {
    const teamDir = join(runDir, 'teams', 'no-creds');
    mkdirSync(teamDir, { recursive: true });
    writeFileSync(join(teamDir, 'config.yaml'), yamlStringify({
      name: 'no-creds',
      allowed_tools: ['*'],
    }));

    migrateCredentialsToVault(store, runDir, log);

    expect(store.calls).toHaveLength(0);
    expect(log).not.toHaveBeenCalled();
  });

  it('skips non-string credential values', () => {
    const teamDir = join(runDir, 'teams', 'mixed');
    mkdirSync(teamDir, { recursive: true });
    writeFileSync(join(teamDir, 'config.yaml'), yamlStringify({
      name: 'mixed',
      credentials: { GOOD_ENTRY: 'valid-value', BAD_ENTRY: 42 },
    }));

    migrateCredentialsToVault(store, runDir, log);

    expect(store.calls).toHaveLength(1);
    expect(store.calls[0].key).toBe('GOOD_ENTRY');
  });

  it('handles missing teams directory gracefully', () => {
    const emptyDir = makeTmpDir();
    migrateCredentialsToVault(store, emptyDir, log);
    expect(store.calls).toHaveLength(0);
  });

  it('processes multiple teams', () => {
    for (const name of ['t1', 't2']) {
      const dir = join(runDir, 'teams', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'config.yaml'), yamlStringify({
        name,
        credentials: { [`ENTRY_${name}`]: `val_${name}` },
      }));
    }

    migrateCredentialsToVault(store, runDir, log);

    expect(store.calls).toHaveLength(2);
    const keys = store.calls.map(c => c.key);
    expect(keys).toContain('ENTRY_t1');
    expect(keys).toContain('ENTRY_t2');
  });
});
