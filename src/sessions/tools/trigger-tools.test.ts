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
    setActiveTask: vi.fn(),
    clearActiveTask: vi.fn(),
    setOverlapCount: vi.fn(),
    resetOverlapState: vi.fn(),
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

  // ── Subagent passthrough (AC-13) ──────────────────────────────────────────

  it('create_trigger description mentions subagent routing', () => {
    const ctx = createMockContext();
    const tools = buildTriggerTools(ctx);
    const create = tools['create_trigger'];
    expect(create.description).toMatch(/subagent/i);
  });

  it('update_trigger description mentions subagent routing', () => {
    const ctx = createMockContext();
    const tools = buildTriggerTools(ctx);
    const update = tools['update_trigger'];
    expect(update.description).toMatch(/subagent/i);
  });

  it('list_triggers description mentions subagent in output', () => {
    const ctx = createMockContext();
    const tools = buildTriggerTools(ctx);
    const list = tools['list_triggers'];
    expect(list.description).toMatch(/subagent/i);
  });

  it('create_trigger input schema accepts optional subagent field', async () => {
    const ctx = createMockContext();
    const tools = buildTriggerTools(ctx);
    const create = tools['create_trigger'];
    // Schema object is exposed via `inputSchema`
    const schema = create.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
    const valid = schema.safeParse({
      team: 'child-team', name: 'my-trig', type: 'schedule',
      config: { cron: '*/5 * * * *' }, task: 'do stuff', subagent: 'researcher',
    });
    expect(valid.success).toBe(true);

    const empty = schema.safeParse({
      team: 'child-team', name: 'my-trig', type: 'schedule',
      config: { cron: '*/5 * * * *' }, task: 'do stuff', subagent: '',
    });
    expect(empty.success).toBe(false);
  });

  it('update_trigger input schema accepts optional subagent field', () => {
    const ctx = createMockContext();
    const tools = buildTriggerTools(ctx);
    const update = tools['update_trigger'];
    const schema = update.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
    const valid = schema.safeParse({
      team: 'child-team', trigger_name: 'my-trig', subagent: 'researcher',
    });
    expect(valid.success).toBe(true);

    const empty = schema.safeParse({
      team: 'child-team', trigger_name: 'my-trig', subagent: '',
    });
    expect(empty.success).toBe(false);
  });
});

// ── test_trigger schema wiring (AC-7) ────────────────────────────────────────

type SchemaBag = { safeParse: (v: unknown) => { success: boolean; data: Record<string, unknown> } };

describe('test_trigger tool wiring', () => {
  it('tool schema accepts overlap_policy and defaults to confirm', () => {
    const ctx = createMockContext();
    const tools = buildTriggerTools(ctx);
    const test = tools['test_trigger'];
    expect(test).toBeTruthy();

    const schema = test.inputSchema as unknown as SchemaBag;

    // Default overlap_policy is 'confirm'
    const r1 = schema.safeParse({ team: 'A', trigger_name: 'x' });
    expect(r1.success).toBe(true);
    expect(r1.data.overlap_policy).toBe('confirm');

    // Accepts explicit 'skip'
    const r2 = schema.safeParse({ team: 'A', trigger_name: 'x', overlap_policy: 'skip' });
    expect(r2.success).toBe(true);
    expect(r2.data.overlap_policy).toBe('skip');

    // Rejects invalid value
    const r3 = schema.safeParse({ team: 'A', trigger_name: 'x', overlap_policy: 'bogus' });
    expect(r3.success).toBe(false);
  });
});
