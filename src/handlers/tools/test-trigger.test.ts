/**
 * test_trigger handler tests.
 *
 * Covers concurrency policy matrix plus error paths, field naming, and
 * max_steps snapshot behaviour.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { testTrigger, TestTriggerInputSchema } from './test-trigger.js';
import type { TestTriggerDeps, TestTriggerResult } from './test-trigger.js';
import { createMockTaskQueue, createMemoryOrgStore, makeNode } from '../__test-helpers.js';
import { OrgTree } from '../../domain/org-tree.js';
import type { ITriggerConfigStore } from '../../domain/interfaces.js';
import type { TriggerConfig, TaskEntry, TaskType } from '../../domain/types.js';
import { TaskStatus } from '../../domain/types.js';

// ── Minimal ITriggerConfigStore mock ─────────────────────────────────────────

function createMockConfigStore(initial: TriggerConfig[] = []): ITriggerConfigStore {
  const data: TriggerConfig[] = [...initial];
  return {
    upsert(config: TriggerConfig): void { data.push(config); },
    remove(): void {},
    removeByTeam(): void {},
    getByTeam(team: string): TriggerConfig[] { return data.filter((t) => t.team === team); },
    getAll(): TriggerConfig[] { return [...data]; },
    setState(): void {},
    incrementFailures(): number { return 0; },
    resetFailures(): void {},
    get(team: string, name: string): TriggerConfig | undefined {
      return data.find((t) => t.team === team && t.name === name);
    },
    setActiveTask(): void {},
    clearActiveTask(): void {},
    setOverlapCount(): void {},
    resetOverlapState(): void {},
  };
}

// ── Test-layer wrapper that adds Zod schema validation ───────────────────────
// Mirrors the tool layer where the AI SDK validates input before calling the handler.

function call(
  args: unknown,
  callerId: string,
  deps: TestTriggerDeps,
  sourceChannelId?: string,
): TestTriggerResult {
  const parsed = TestTriggerInputSchema.safeParse(args);
  if (!parsed.success) {
    return { success: false, error: `invalid input: ${parsed.error.message}` };
  }
  return testTrigger(parsed.data, callerId, deps, sourceChannelId);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TRIGGER_FIXTURE: TriggerConfig = {
  name: 'x',
  type: 'schedule',
  config: {},
  team: 'ops',
  task: 'do something scheduled',
};

describe('test_trigger concurrency', () => {
  let taskQueue: ReturnType<typeof createMockTaskQueue>;
  let configStore: ITriggerConfigStore;
  let orgTree: OrgTree;
  let deps: TestTriggerDeps;

  function seedTask(overrides: {
    teamId: string;
    type?: TaskType;
    status?: TaskStatus;
    createdAt?: string;
  }): TaskEntry {
    const entry: TaskEntry = {
      id: `seed-${Math.random().toString(36).slice(2, 8)}`,
      task: 'existing task',
      priority: 'normal',
      type: overrides.type ?? 'delegate',
      status: overrides.status ?? TaskStatus.Pending,
      teamId: overrides.teamId,
      createdAt: overrides.createdAt ?? new Date().toISOString(),
      correlationId: null,
      result: null,
      durationMs: null,
      options: null,
      sourceChannelId: null,
    };
    taskQueue.tasks.push(entry);
    return entry;
  }

  beforeEach(() => {
    taskQueue = createMockTaskQueue();
    // Seed the trigger so trigger-not-found is avoided in happy-path tests.
    configStore = createMockConfigStore([TRIGGER_FIXTURE]);
    const store = createMemoryOrgStore();
    orgTree = new OrgTree(store);
    orgTree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    orgTree.addTeam(makeNode({ teamId: 'ops', name: 'ops', parentId: 'root' }));
    deps = {
      orgTree,
      configStore,
      taskQueue,
      log: () => {},
    };
  });

  // ── Concurrency matrix ──────────────────────────────────────────────────────

  it('default policy is confirm → requires_confirmation when team has active work', () => {
    seedTask({ teamId: 'ops', type: 'bootstrap', status: TaskStatus.Running });
    const r = call({ team: 'ops', trigger_name: 'x' }, 'root', deps);
    expect(r.enqueued).toBe(false);
    expect(r.requires_confirmation).toBe(true);
    expect(r.overlap_policy_applied).toBe('confirm');
  });

  it('skip → returns enqueued:false, still success:true', () => {
    seedTask({ teamId: 'ops', type: 'delegate', status: TaskStatus.Pending });
    const r = call({ team: 'ops', trigger_name: 'x', overlap_policy: 'skip' }, 'root', deps);
    expect(r.success).toBe(true);
    expect(r.enqueued).toBe(false);
  });

  it('allow → enqueues despite active work and uses taskId field name (not task_id)', () => {
    seedTask({ teamId: 'ops', type: 'bootstrap', status: TaskStatus.Running });
    const r = call({ team: 'ops', trigger_name: 'x', overlap_policy: 'allow' }, 'root', deps);
    expect(r.enqueued).toBe(true);
    expect(typeof r.taskId).toBe('string');
    expect((r.taskId as string).length).toBeGreaterThan(0);
    // Field must not be renamed — existing callers depend on "taskId"
    expect((r as unknown as { task_id?: unknown }).task_id).toBeUndefined();
  });

  it('replace with pending-only → cancels pending, enqueues', () => {
    const pending = seedTask({ teamId: 'ops', type: 'delegate', status: TaskStatus.Pending });
    const r = call({ team: 'ops', trigger_name: 'x', overlap_policy: 'replace' }, 'root', deps);
    expect(r.enqueued).toBe(true);
    expect(taskQueue.getActiveForTeam('ops').map((t) => t.id)).not.toContain(pending.id);
  });

  it('replace with non-stale running → downgrades to requires_confirmation', () => {
    seedTask({
      teamId: 'ops',
      type: 'bootstrap',
      status: TaskStatus.Running,
      createdAt: new Date().toISOString(), // fresh — not stale
    });
    const r = call({ team: 'ops', trigger_name: 'x', overlap_policy: 'replace' }, 'root', deps);
    expect(r.requires_confirmation).toBe(true);
    expect(r.reason).toBe('replace_targets_running_session');
  });

  it('invalid overlap_policy is rejected by the Zod schema', () => {
    const r = call({ team: 'ops', trigger_name: 'x', overlap_policy: 'bogus' as unknown as 'wait' }, 'root', deps);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/overlap_policy/i);
  });

  // ── Error paths ──────────────────────────────────────────────────────────────

  it('trigger-not-found → success:false, no concurrency fields', () => {
    const r = call({ team: 'ops', trigger_name: 'ghost' }, 'root', deps);
    expect(r.success).toBe(false);
    expect(r.enqueued).toBeUndefined();
    expect(r.requires_confirmation).toBeUndefined();
  });

  it('team-not-found → success:false, no concurrency fields', () => {
    const r = call({ team: 'ghost-team', trigger_name: 'x' }, 'root', deps);
    expect(r.success).toBe(false);
    expect(r.enqueued).toBeUndefined();
    expect(r.requires_confirmation).toBeUndefined();
  });

  it('not-parent → success:false, no concurrency fields', () => {
    // 'sibling' is a top-level team — its parentId is undefined, not 'root'.
    // Calling as 'other' (non-root, non-parent) should fail the parent guard.
    orgTree.addTeam(makeNode({ teamId: 'other', name: 'other' }));
    const r = call({ team: 'ops', trigger_name: 'x' }, 'other', deps);
    expect(r.success).toBe(false);
    expect(r.enqueued).toBeUndefined();
    expect(r.requires_confirmation).toBeUndefined();
  });

  // ── Snapshot behaviour ───────────────────────────────────────────────────────

  it('max_steps snapshot is carried into the enqueued task options', () => {
    const r = call({ team: 'ops', trigger_name: 'x', max_steps: 5 }, 'root', deps);
    expect(r.enqueued).toBe(true);
    const enqueued = taskQueue.getActiveForTeam('ops')[0];
    expect(enqueued?.options?.maxSteps).toBe(5);
  });
});
