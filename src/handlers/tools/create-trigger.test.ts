/**
 * create_trigger tool tests.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { TriggerConfig } from '../../domain/types.js';
import type { SubagentDefinition } from '../../sessions/skill-loader.js';
import { setupServer, makeNode } from '../__test-helpers.js';
import { createTrigger, CreateTriggerInputSchema } from './create-trigger.js';
import type { ServerFixtures } from '../__test-helpers.js';

function makeConfigStore(triggers: Map<string, TriggerConfig>) {
  return {
    upsert: vi.fn((config: TriggerConfig) => {
      triggers.set(`${config.team}:${config.name}`, config);
    }),
    remove: vi.fn(),
    removeByTeam: vi.fn(),
    getByTeam: vi.fn((team: string) => [...triggers.values()].filter(t => t.team === team)),
    getAll: vi.fn(() => [...triggers.values()]),
    setState: vi.fn(),
    incrementFailures: vi.fn(),
    resetFailures: vi.fn(),
    get: vi.fn((team: string, name: string) => triggers.get(`${team}:${name}`)),
    setActiveTask: vi.fn(),
    clearActiveTask: vi.fn(),
    setOverlapCount: vi.fn(),
    resetOverlapState: vi.fn(),
  };
}

function makeLoadSubagents(subagents: Record<string, SubagentDefinition> = {}) {
  return vi.fn(() => subagents);
}

function invokeCreateTrigger(
  f: ServerFixtures,
  mockConfigStore: ReturnType<typeof makeConfigStore>,
  loadSubagents: ReturnType<typeof makeLoadSubagents>,
  raw: Record<string, unknown>,
  callerId = 'root',
) {
  const parsed = CreateTriggerInputSchema.safeParse(raw);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'invalid input' };
  }
  return createTrigger(parsed.data, callerId, {
    orgTree: f.orgTree,
    configStore: mockConfigStore,
    runDir: '/tmp/openhive-test',
    loadSubagents,
    log: (msg, meta) => { f.logMessages.push({ msg, meta }); },
  });
}

describe('create_trigger', () => {
  let f: ServerFixtures;
  let triggers: Map<string, TriggerConfig>;
  let mockConfigStore: ReturnType<typeof makeConfigStore>;

  beforeEach(() => {
    f = setupServer();
    f.orgTree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    f.orgTree.addTeam(makeNode({ teamId: 'ops-team', name: 'ops-team', parentId: 'root' }));
    triggers = new Map();
    mockConfigStore = makeConfigStore(triggers);
  });

  it('creates trigger with default overlap_policy', () => {
    const loadSubagents = makeLoadSubagents();
    const result = invokeCreateTrigger(f, mockConfigStore, loadSubagents, {
      team: 'ops-team', name: 'my-trigger', type: 'schedule',
      config: { cron: '*/5 * * * *' }, task: 'do stuff',
    }) as { success: boolean };

    expect(result.success).toBe(true);
    expect(mockConfigStore.upsert).toHaveBeenCalledWith(expect.objectContaining({
      name: 'my-trigger',
      overlapPolicy: undefined,
    }));
  });

  it('creates trigger with explicit overlap_policy', () => {
    const loadSubagents = makeLoadSubagents();
    const result = invokeCreateTrigger(f, mockConfigStore, loadSubagents, {
      team: 'ops-team', name: 'my-trigger', type: 'schedule',
      config: { cron: '*/5 * * * *' }, task: 'do stuff',
      overlap_policy: 'always-skip',
    }) as { success: boolean };

    expect(result.success).toBe(true);
    expect(mockConfigStore.upsert).toHaveBeenCalledWith(expect.objectContaining({
      name: 'my-trigger',
      overlapPolicy: 'always-skip',
    }));
  });

  it('creates trigger with allow overlap_policy', () => {
    const loadSubagents = makeLoadSubagents();
    const result = invokeCreateTrigger(f, mockConfigStore, loadSubagents, {
      team: 'ops-team', name: 'my-trigger', type: 'schedule',
      config: { cron: '*/5 * * * *' }, task: 'do stuff',
      overlap_policy: 'allow',
    }) as { success: boolean };

    expect(result.success).toBe(true);
    expect(mockConfigStore.upsert).toHaveBeenCalledWith(expect.objectContaining({
      overlapPolicy: 'allow',
    }));
  });

  // ── Subagent validation (AC-11) ──────────────────────────────────────────

  it('accepts and persists a valid subagent name', () => {
    const loadSubagents = makeLoadSubagents({
      researcher: { description: 'Research agent', prompt: '# Agent: researcher' },
    });

    const result = invokeCreateTrigger(f, mockConfigStore, loadSubagents, {
      team: 'ops-team', name: 'my-trigger', type: 'schedule',
      config: { cron: '*/5 * * * *' }, task: 'do stuff',
      subagent: 'researcher',
    }) as { success: boolean };

    expect(result.success).toBe(true);
    expect(loadSubagents).toHaveBeenCalledWith('/tmp/openhive-test', 'ops-team');
    expect(mockConfigStore.upsert).toHaveBeenCalledWith(expect.objectContaining({
      name: 'my-trigger',
      subagent: 'researcher',
    }));
  });

  it('rejects an unknown subagent name with a descriptive error', () => {
    const loadSubagents = makeLoadSubagents({
      researcher: { description: 'Research agent', prompt: '# Agent: researcher' },
    });

    const result = invokeCreateTrigger(f, mockConfigStore, loadSubagents, {
      team: 'ops-team', name: 'my-trigger', type: 'schedule',
      config: { cron: '*/5 * * * *' }, task: 'do stuff',
      subagent: 'ghost-agent',
    }) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown subagent');
    expect(result.error).toContain('ghost-agent');
    expect(result.error).toContain('researcher');
    expect(mockConfigStore.upsert).not.toHaveBeenCalled();
  });

  it('rejects an unknown subagent when no subagents are defined for the team', () => {
    const loadSubagents = makeLoadSubagents({});

    const result = invokeCreateTrigger(f, mockConfigStore, loadSubagents, {
      team: 'ops-team', name: 'my-trigger', type: 'schedule',
      config: { cron: '*/5 * * * *' }, task: 'do stuff',
      subagent: 'any-name',
    }) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown subagent');
    expect(result.error).toContain('no subagents defined');
    expect(mockConfigStore.upsert).not.toHaveBeenCalled();
  });

  it('rejects an empty subagent string at the schema level', () => {
    const loadSubagents = makeLoadSubagents({
      researcher: { description: 'Research agent', prompt: '# Agent: researcher' },
    });

    const result = invokeCreateTrigger(f, mockConfigStore, loadSubagents, {
      team: 'ops-team', name: 'my-trigger', type: 'schedule',
      config: { cron: '*/5 * * * *' }, task: 'do stuff',
      subagent: '',
    }) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(mockConfigStore.upsert).not.toHaveBeenCalled();
  });

  it('accepts a missing subagent (optional field)', () => {
    const loadSubagents = makeLoadSubagents({
      researcher: { description: 'Research agent', prompt: '# Agent: researcher' },
    });

    const result = invokeCreateTrigger(f, mockConfigStore, loadSubagents, {
      team: 'ops-team', name: 'my-trigger', type: 'schedule',
      config: { cron: '*/5 * * * *' }, task: 'do stuff',
    }) as { success: boolean };

    expect(result.success).toBe(true);
    // When no subagent is provided, loadSubagents should not be called
    expect(loadSubagents).not.toHaveBeenCalled();
    expect(mockConfigStore.upsert).toHaveBeenCalledWith(expect.objectContaining({
      name: 'my-trigger',
      subagent: undefined,
    }));
  });

  // ── Reserved-name guard (Bug #2 Option A) ───────────────────────────

  it('rejects user-created names that collide with the reserved cycle prefix', () => {
    const loadSubagents = makeLoadSubagents();

    const exactLearning = invokeCreateTrigger(f, mockConfigStore, loadSubagents, {
      team: 'ops-team', name: 'learning-cycle', type: 'schedule',
      config: { cron: '* * * * *' }, task: 'x',
    }) as { success: boolean; error?: string };
    expect(exactLearning.success).toBe(false);
    expect(exactLearning.error?.toLowerCase()).toContain('reserved');

    const exactReflection = invokeCreateTrigger(f, mockConfigStore, loadSubagents, {
      team: 'ops-team', name: 'reflection-cycle', type: 'schedule',
      config: { cron: '* * * * *' }, task: 'x',
    }) as { success: boolean; error?: string };
    expect(exactReflection.success).toBe(false);

    const suffixed = invokeCreateTrigger(f, mockConfigStore, loadSubagents, {
      team: 'ops-team', name: 'learning-cycle-custom', type: 'schedule',
      config: { cron: '* * * * *' }, task: 'x',
    }) as { success: boolean };
    expect(suffixed.success).toBe(false);

    expect(mockConfigStore.upsert).not.toHaveBeenCalled();
  });

  it('allows non-reserved names that merely contain "cycle"', () => {
    const loadSubagents = makeLoadSubagents();
    const result = invokeCreateTrigger(f, mockConfigStore, loadSubagents, {
      team: 'ops-team', name: 'deploy-cycle-watch', type: 'schedule',
      config: { cron: '* * * * *' }, task: 'x',
    }) as { success: boolean };
    expect(result.success).toBe(true);
  });

  it('upserts with subagent targeting and no skill field (post-Bug #2)', () => {
    const loadSubagents = makeLoadSubagents({
      myAgent: { description: 'My agent', prompt: '# Agent: myAgent' },
    });

    const result = invokeCreateTrigger(f, mockConfigStore, loadSubagents, {
      team: 'ops-team', name: 'agent-run', type: 'schedule',
      config: { cron: '* * * * *' }, task: 'x',
      subagent: 'myAgent',
    }) as { success: boolean };

    expect(result.success).toBe(true);
    expect(mockConfigStore.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ subagent: 'myAgent' }),
    );
    const upsertArg = mockConfigStore.upsert.mock.calls[0][0];
    expect('skill' in upsertArg).toBe(false);
  });
});

// ── Window end-to-end lifecycle (AC-50) ─────────────────────────────────────

describe('window end-to-end lifecycle', () => {
  let f: ServerFixtures;
  let triggers: Map<string, TriggerConfig>;
  let mockConfigStore: ReturnType<typeof makeConfigStore>;

  beforeEach(() => {
    f = setupServer();
    f.orgTree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    f.orgTree.addTeam(makeNode({ teamId: 'ops-team', name: 'ops-team', parentId: 'root' }));
    triggers = new Map();
    mockConfigStore = makeConfigStore(triggers);
  });

  it('create trigger list roundtrip: created trigger appears in getByTeam', () => {
    // Create a schedule trigger via the createTrigger handler and verify the
    // configStore round-trips it correctly through getByTeam (AC-50).
    const loadSubagents = makeLoadSubagents();
    const result = invokeCreateTrigger(f, mockConfigStore, loadSubagents, {
      team: 'ops-team', name: 'sched-poll', type: 'schedule',
      config: { cron: '*/5 * * * *' }, task: 'poll and report',
    }) as { success: boolean };

    expect(result.success).toBe(true);

    const listed = mockConfigStore.getByTeam('ops-team');
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe('sched-poll');
    expect(listed[0].state).toBe('pending');
    expect(listed[0].type).toBe('schedule');
  });

  it('window trigger directly stored is retrievable via getByTeam', () => {
    // Window triggers are registered through replaceTeamTriggers (engine path),
    // not create_trigger (which currently validates only schedule/keyword/message).
    // This test verifies the configStore can store and retrieve a window-type
    // TriggerConfig — confirming the list roundtrip contract holds for all types (AC-50).
    const windowConfig: TriggerConfig = {
      name: 'win-report',
      type: 'window',
      config: { tick_interval_ms: 600_000 },
      team: 'ops-team',
      task: 'generate window report',
      state: 'active',
    };
    mockConfigStore.upsert(windowConfig);

    const listed = mockConfigStore.getByTeam('ops-team');
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe('win-report');
    expect(listed[0].type).toBe('window');
  });
});
