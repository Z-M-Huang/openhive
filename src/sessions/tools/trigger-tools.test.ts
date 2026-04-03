/**
 * Trigger Tool Builders — unit tests.
 *
 * Tests buildTriggerTools: tool count, bare names, alphabetical sort,
 * and conditional inclusion based on triggerConfigStore.
 */

import { describe, it, expect, vi } from 'vitest';

import { buildTriggerTools } from './trigger-tools.js';
import type { OrgToolContext } from './org-tool-context.js';
import type { ITriggerConfigStore } from '../../domain/interfaces.js';
import { OrgTree } from '../../domain/org-tree.js';
import { createMemoryOrgStore, createMockTaskQueue, createMockEscalationStore } from '../../handlers/__test-helpers.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockTriggerConfigStore(): ITriggerConfigStore {
  return {
    upsert: vi.fn(),
    get: vi.fn().mockReturnValue(undefined),
    getByTeam: vi.fn().mockReturnValue([]),
    getAll: vi.fn().mockReturnValue([]),
    remove: vi.fn(),
    removeByTeam: vi.fn(),
    setState: vi.fn(),
    incrementFailures: vi.fn().mockReturnValue(0),
    resetFailures: vi.fn(),
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
    triggerConfigStore: createMockTriggerConfigStore(),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('buildTriggerTools', () => {
  it('returns exactly 6 tools when triggerConfigStore is provided', () => {
    const ctx = createMockContext();
    const tools = buildTriggerTools(ctx);
    expect(Object.keys(tools)).toHaveLength(6);
  });

  it('returns 0 tools when triggerConfigStore is undefined', () => {
    const ctx = createMockContext({ triggerConfigStore: undefined });
    const tools = buildTriggerTools(ctx);
    expect(Object.keys(tools)).toHaveLength(0);
  });

  it('uses bare tool names (not prefixed)', () => {
    const ctx = createMockContext();
    const tools = buildTriggerTools(ctx);
    const names = Object.keys(tools);

    const expected = [
      'create_trigger',
      'disable_trigger',
      'enable_trigger',
      'list_triggers',
      'test_trigger',
      'update_trigger',
    ];

    for (const name of expected) {
      expect(names).toContain(name);
    }

    for (const name of names) {
      expect(name).not.toContain('mcp__');
    }
  });

  it('returns tools in alphabetical order', () => {
    const ctx = createMockContext();
    const tools = buildTriggerTools(ctx);
    const names = Object.keys(tools);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });

  it('every tool has an execute function and description', () => {
    const ctx = createMockContext();
    const tools = buildTriggerTools(ctx);

    for (const [name, t] of Object.entries(tools)) {
      expect(typeof t.execute, `${name} should have execute`).toBe('function');
      expect(typeof t.description, `${name} should have description`).toBe('string');
    }
  });
});
