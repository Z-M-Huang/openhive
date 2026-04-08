/**
 * Vault Tool Builders — unit tests.
 *
 * Tests buildVaultTools: tool count, bare names, empty when no store.
 */

import { describe, it, expect, vi } from 'vitest';

import { buildVaultTools } from './vault-tools.js';
import type { OrgToolContext } from './org-tool-context.js';
import type { IVaultStore } from '../../domain/interfaces.js';
import { OrgTree } from '../../domain/org-tree.js';
import { createMemoryOrgStore, createMockTaskQueue, createMockEscalationStore } from '../../handlers/__test-helpers.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMockVaultStore(): { [K in keyof IVaultStore]: ReturnType<typeof vi.fn> } {
  return {
    set: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
    getSecrets: vi.fn(),
    removeByTeam: vi.fn(),
  };
}

function createMockContext(overrides?: Partial<OrgToolContext>): OrgToolContext {
  const store = createMemoryOrgStore();
  const orgTree = new OrgTree(store);

  return {
    teamName: 'main',
    orgTree,
    spawner: { spawn: vi.fn().mockResolvedValue('session-1') },
    sessionManager: { getSession: vi.fn(), terminateSession: vi.fn() },
    taskQueue: createMockTaskQueue(),
    escalationStore: createMockEscalationStore(),
    runDir: '/tmp/openhive-test',
    loadConfig: vi.fn(),
    getTeamConfig: vi.fn(),
    log: vi.fn(),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('buildVaultTools', () => {
  it('returns empty object when vaultStore is undefined', () => {
    const ctx = createMockContext({ vaultStore: undefined });
    const tools = buildVaultTools(ctx);
    expect(Object.keys(tools)).toHaveLength(0);
  });

  it('returns exactly 4 tools when vaultStore is defined', () => {
    const ctx = createMockContext({
      vaultStore: makeMockVaultStore() as unknown as IVaultStore,
    });
    const tools = buildVaultTools(ctx);
    expect(Object.keys(tools)).toHaveLength(4);
  });

  it('uses bare tool names (not prefixed)', () => {
    const ctx = createMockContext({
      vaultStore: makeMockVaultStore() as unknown as IVaultStore,
    });
    const tools = buildVaultTools(ctx);
    const names = Object.keys(tools);

    const expected = ['vault_set', 'vault_get', 'vault_list', 'vault_delete'];
    for (const name of expected) {
      expect(names).toContain(name);
    }

    // No prefixed names
    for (const name of names) {
      expect(name).not.toContain('mcp__');
    }
  });

  it('every tool has an execute function', () => {
    const ctx = createMockContext({
      vaultStore: makeMockVaultStore() as unknown as IVaultStore,
    });
    const tools = buildVaultTools(ctx);

    for (const [, t] of Object.entries(tools)) {
      const asTool = t as { execute?: unknown };
      expect(typeof asTool.execute).toBe('function');
    }
  });
});
