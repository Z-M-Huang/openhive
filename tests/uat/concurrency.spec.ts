/**
 * OpenHive — Spawn-Team Concurrency UAT
 *
 * UAT-1: spawn_team truthful queued return + deferred readiness + wiki cross-check
 * UAT-2: concurrency awareness across confirm/allow/skip/replace policies + wiki cross-check
 *
 * Unit 17: stubs replaced with real handler invocations via in-memory mocks.
 *
 * NOTE: All helper factories are defined locally (not imported from __test-helpers.ts)
 * because that module imports `vi` from vitest, which conflicts with Playwright's
 * expect matchers and produces "Cannot redefine property: Symbol($$jest-matchers-object)".
 */

import { test, expect } from 'playwright/test';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import * as fs from 'node:fs';

import { fileExists, readFile } from './helpers/repo-helper.js';
import { OrgTree } from '../../src/domain/org-tree.js';
import {
  TeamStatus,
  TaskStatus,
} from '../../src/domain/types.js';
import type {
  IOrgStore,
  ITaskQueueStore,
  ITriggerConfigStore,
} from '../../src/domain/interfaces.js';
import type {
  OrgTreeNode,
  TeamConfig,
  TaskEntry,
  TriggerConfig,
  TaskPriority,
  TaskType,
  TaskOptions,
} from '../../src/domain/types.js';
import { spawnTeam } from '../../src/handlers/tools/spawn-team.js';
import { delegateTask } from '../../src/handlers/tools/delegate-task.js';
import { testTrigger } from '../../src/handlers/tools/test-trigger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..', '..');
const WIKI_ROOT = join(ROOT, '..', 'openhive.wiki');

// ============================================================================
// Local factory functions (vitest-free — safe for Playwright context)
// ============================================================================

function makeNode(overrides: Partial<OrgTreeNode> & { teamId: string; name: string }): OrgTreeNode {
  return {
    parentId: null,
    status: TeamStatus.Idle,
    agents: [],
    children: [],
    ...overrides,
  };
}

function makeTeamConfig(overrides?: Partial<TeamConfig>): TeamConfig {
  return {
    name: 'test-team',
    parent: null,
    description: 'A test team',
    allowed_tools: [],
    provider_profile: 'default',
    maxSteps: 50,
    ...overrides,
  };
}

function createMemoryOrgStore(): IOrgStore {
  const data = new Map<string, OrgTreeNode>();
  const scopeMap = new Map<string, Set<string>>();
  return {
    addTeam(node: OrgTreeNode): void { data.set(node.teamId, node); },
    removeTeam(id: string): void { scopeMap.delete(id); data.delete(id); },
    getTeam(id: string): OrgTreeNode | undefined { return data.get(id); },
    getChildren(parentId: string): OrgTreeNode[] {
      return [...data.values()].filter((n) => n.parentId === parentId);
    },
    getAncestors(): OrgTreeNode[] { return []; },
    getAll(): OrgTreeNode[] { return [...data.values()]; },
    addScopeKeywords(teamId: string, keywords: string[]): void {
      const set = scopeMap.get(teamId) ?? new Set();
      for (const kw of keywords) set.add(kw.toLowerCase().trim());
      scopeMap.set(teamId, set);
    },
    removeScopeKeywords(teamId: string): void { scopeMap.delete(teamId); },
    removeScopeKeyword(teamId: string, keyword: string): void {
      scopeMap.get(teamId)?.delete(keyword.toLowerCase().trim());
    },
    getOwnScope(teamId: string): string[] { return [...(scopeMap.get(teamId) ?? [])]; },
    getEffectiveScope(teamId: string): string[] {
      const collect = (id: string): string[] => {
        const own = [...(scopeMap.get(id) ?? [])];
        const children = [...data.values()].filter((n) => n.parentId === id);
        for (const child of children) own.push(...collect(child.teamId));
        return own;
      };
      return [...new Set(collect(teamId))];
    },
    setBootstrapped(): void {},
    isBootstrapped(): boolean { return false; },
  };
}

function createMockTaskQueue(): ITaskQueueStore & { tasks: TaskEntry[] } {
  let idCounter = 0;
  const tasks: TaskEntry[] = [];

  return {
    tasks,
    enqueue(teamId: string, task: string, priority: TaskPriority, type?: TaskType, sourceChannelId?: string, correlationId?: string, options?: TaskOptions): string {
      idCounter += 1;
      const id = `task-${String(idCounter).padStart(4, '0')}`;
      tasks.push({
        id,
        teamId,
        task,
        priority: priority || 'normal',
        type: type || 'delegate',
        status: TaskStatus.Pending,
        createdAt: new Date().toISOString(),
        correlationId: correlationId ?? null,
        result: null,
        durationMs: null,
        options: options ?? null,
        sourceChannelId: sourceChannelId ?? null,
      });
      return id;
    },
    dequeue(teamId: string): TaskEntry | undefined {
      const idx = tasks.findIndex((t) => t.teamId === teamId && t.status === TaskStatus.Pending);
      if (idx === -1) return undefined;
      const entry = { ...tasks[idx], status: TaskStatus.Running };
      tasks[idx] = entry;
      return entry;
    },
    peek(teamId: string): TaskEntry | undefined {
      return tasks.find((t) => t.teamId === teamId && t.status === TaskStatus.Pending);
    },
    getActiveForTeam(teamId: string): TaskEntry[] {
      const rank = (p: TaskPriority): number =>
        ({ critical: 0, high: 1, normal: 2, low: 3 } as Record<string, number>)[p] ?? 4;
      return tasks
        .filter((t) => t.teamId === teamId && (t.status === TaskStatus.Pending || t.status === TaskStatus.Running))
        .sort((a, b) => {
          const r = rank(a.priority) - rank(b.priority);
          return r !== 0 ? r : a.createdAt.localeCompare(b.createdAt);
        });
    },
    getByTeam(teamId: string): TaskEntry[] {
      return tasks.filter((t) => t.teamId === teamId);
    },
    updateStatus(taskId: string, status: TaskStatus): void {
      const idx = tasks.findIndex((t) => t.id === taskId);
      if (idx !== -1) {
        tasks[idx] = { ...tasks[idx], status };
      }
    },
    updateResult(taskId: string, result: string): void {
      const idx = tasks.findIndex((t) => t.id === taskId);
      if (idx !== -1) {
        tasks[idx] = { ...tasks[idx], result };
      }
    },
    getPending(): TaskEntry[] {
      return tasks.filter((t) => t.status === TaskStatus.Pending);
    },
    getByStatus(status: TaskStatus): TaskEntry[] {
      return tasks.filter((t) => t.status === status);
    },
    removeByTeam(teamId: string): void {
      const indices = tasks.reduce<number[]>((acc, t, i) => t.teamId === teamId ? [...acc, i] : acc, []);
      for (const i of indices.reverse()) tasks.splice(i, 1);
    },
    getById(taskId: string): TaskEntry | undefined {
      return tasks.find((t) => t.id === taskId);
    },
  };
}

/** Minimal in-memory ITriggerConfigStore for test_trigger tests. */
function createMockTriggerConfigStore(): ITriggerConfigStore {
  const entries = new Map<string, TriggerConfig>();
  const k = (team: string, name: string) => `${team}:${name}`;
  return {
    upsert(config: TriggerConfig) { entries.set(k(config.team, config.name), config); },
    remove(team: string, name: string) { entries.delete(k(team, name)); },
    removeByTeam(team: string) {
      for (const key of entries.keys()) {
        if (key.startsWith(`${team}:`)) entries.delete(key);
      }
    },
    getByTeam(team: string): TriggerConfig[] {
      return [...entries.values()].filter(c => c.team === team);
    },
    getAll(): TriggerConfig[] { return [...entries.values()]; },
    setState() {},
    incrementFailures() { return 0; },
    resetFailures() {},
    get(team: string, name: string): TriggerConfig | undefined { return entries.get(k(team, name)); },
    setActiveTask() {},
    clearActiveTask() {},
    setOverlapCount() {},
    resetOverlapState() {},
  };
}

// ============================================================================
// Per-test mutable state — reset in test.beforeEach
// ============================================================================

let taskQueue: ReturnType<typeof createMockTaskQueue>;
let orgTree: OrgTree;
let tmpRunDir: string;
let triggerConfigStore: ITriggerConfigStore;

test.beforeEach(async () => {
  taskQueue = createMockTaskQueue();
  const store = createMemoryOrgStore();
  orgTree = new OrgTree(store);
  triggerConfigStore = createMockTriggerConfigStore();
  tmpRunDir = mkdtempSync(join(tmpdir(), 'openhive-uat-'));
});

test.afterEach(async () => {
  try { rmSync(tmpRunDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ============================================================================
// Handler helpers — real invocations via in-memory deps
// ============================================================================

/** The caller that acts as parent of all test child teams. */
const CALLER_ID = 'main';

async function invokeSpawnTeam(params: { name: string }) {
  const loadConfig = () => makeTeamConfig({ name: params.name, parent: CALLER_ID });
  return spawnTeam(
    { name: params.name, scope_accepts: ['test'] },
    CALLER_ID,
    {
      orgTree,
      spawner: { spawn: async () => 'session-1' },
      runDir: tmpRunDir,
      loadConfig,
      taskQueue,
    },
  );
}

async function invokeDelegateTask(params: {
  team: string;
  task: string;
  overlap_policy?: string;
}) {
  const policy = (params.overlap_policy ?? 'confirm') as 'allow' | 'skip' | 'replace' | 'confirm';
  return delegateTask(
    { team: params.team, task: params.task, overlap_policy: policy, priority: 'normal' },
    CALLER_ID,
    { orgTree, taskQueue, log: () => {} },
  );
}

async function invokeTestTrigger(params: {
  team: string;
  trigger_name: string;
  overlap_policy?: string;
}) {
  const policy = (params.overlap_policy ?? 'confirm') as 'allow' | 'skip' | 'replace' | 'confirm';

  // Ensure the named trigger exists so the handler can look it up.
  if (!triggerConfigStore.get(params.team, params.trigger_name)) {
    triggerConfigStore.upsert({
      team: params.team,
      name: params.trigger_name,
      type: 'keyword',
      config: {},
      task: `test task for ${params.trigger_name}`,
      state: 'active',
    });
  }

  return testTrigger(
    { team: params.team, trigger_name: params.trigger_name, overlap_policy: policy },
    CALLER_ID,
    { orgTree, configStore: triggerConfigStore, taskQueue, log: () => {} },
  );
}

/**
 * Seed a Running bootstrap task for the given team so the busy-guard
 * treats the team as occupied.  Also registers the team in the org tree
 * with CALLER_ID as parent (idempotent).
 */
async function seedActiveBootstrapTask(team: string): Promise<void> {
  if (!orgTree.getTeam(team)) {
    orgTree.addTeam(makeNode({ teamId: team, name: team, parentId: CALLER_ID }));
  }
  const id = taskQueue.enqueue(team, 'bootstrap task', 'critical', 'bootstrap');
  taskQueue.updateStatus(id, TaskStatus.Running);
}

// ============================================================================
// UAT-1: spawn_team returns queued + deferred readiness
// ============================================================================

test('UAT-1: spawn_team returns queued + message_for_user + bootstrap_task_id', async () => {
  const result = await invokeSpawnTeam({ name: 'ops-team' });
  expect(result.success).toBe(true);
  expect(result.status).toBe('queued');
  // bootstrap_task_id is the raw task ID from the queue store (format: task-NNNN or task-<hex>)
  expect(result.bootstrap_task_id).toMatch(/^task-[\w]+/);
  expect(result.message_for_user).toMatch(/being set up|confirm.*ready/i);

  const wikiPath = join(WIKI_ROOT, 'Organization-Tools.md');
  if (fileExists(wikiPath)) {
    const wiki = fs.readFileSync(wikiPath, 'utf8');
    expect(wiki).toMatch(/spawn_team[\s\S]{0,400}queued/);
    expect(wiki).toMatch(/bootstrap_task_id/);
  }
});

test('UAT-1: Scenarios.md wiki cross-check lines 9-72', async () => {
  const scenariosPath = join(WIKI_ROOT, 'Scenarios.md');
  if (fileExists(scenariosPath)) {
    const wiki = fs.readFileSync(scenariosPath, 'utf8');
    const lines = wiki.split('\n').slice(8, 72).join('\n');
    expect(lines).toMatch(/spawn_team|team.*spawn/i);
  }
});

test('UAT-1: TaskConsumer notification text preserved verbatim', async () => {
  const content = readFile(join(ROOT, 'src/sessions/task-consumer.ts'));
  expect(content).not.toBeNull();
  expect(content!).toContain('[${task.teamId}] Team bootstrapped and ready.');
});

// ============================================================================
// UAT-2: delegate_task / test_trigger concurrency policy guards
// ============================================================================

test('UAT-2: delegate_task default policy returns requires_confirmation when team busy', async () => {
  await seedActiveBootstrapTask('ops-team');
  const result = await invokeDelegateTask({ team: 'ops-team', task: 'test it' });
  expect(result.enqueued).toBe(false);
  expect(result.requires_confirmation).toBe(true);
  expect(result.overlap_policy_applied).toBe('confirm');
  expect(result.in_flight?.[0]?.type).toBe('bootstrap');
});

test('UAT-2: test_trigger default policy same guard', async () => {
  await seedActiveBootstrapTask('ops-team');
  const result = await invokeTestTrigger({ team: 'ops-team', trigger_name: 'x' });
  expect(result.enqueued).toBe(false);
  expect(result.requires_confirmation).toBe(true);
});

test('UAT-2: overlap_policy=allow bypasses guard', async () => {
  await seedActiveBootstrapTask('ops-team');
  const result = await invokeDelegateTask({ team: 'ops-team', task: 'retry', overlap_policy: 'allow' });
  expect(result.enqueued).toBe(true);
});

test('UAT-2: wiki cross-check — overlap_policy documented', async () => {
  const wikiPath = join(WIKI_ROOT, 'Organization-Tools.md');
  if (fileExists(wikiPath)) {
    const wiki = fs.readFileSync(wikiPath, 'utf8');
    expect(wiki).toMatch(/delegate_task[\s\S]{0,400}overlap_policy/);
    expect(wiki).toMatch(/test_trigger[\s\S]{0,400}overlap_policy/);
  }
});

test('UAT-2: concurrency guard asserts no more than 1 running task per team during bootstrap', async () => {
  // Replay the Discord 4-concurrent-session scenario with guard in place.
  const spawn = await invokeSpawnTeam({ name: 'ops-team' });
  expect(spawn.status).toBe('queued');

  // The ops-team is now in the org tree (added by spawnTeam). Simulate main
  // trying to invoke test_trigger while bootstrap is running by marking the
  // bootstrap task as Running.
  const bootstrapTask = taskQueue.tasks.find(t => t.teamId === 'ops-team');
  if (bootstrapTask) {
    taskQueue.updateStatus(bootstrapTask.id, TaskStatus.Running);
  }

  // Default confirm policy — should block.
  const test1 = await invokeTestTrigger({ team: 'ops-team', trigger_name: 'x' });
  expect(test1.requires_confirmation).toBe(true);
  expect(test1.enqueued).toBe(false);

  // Main retries with 'allow' — now the trigger task enqueues (Pending).
  const test2 = await invokeTestTrigger({ team: 'ops-team', trigger_name: 'x', overlap_policy: 'allow' });
  expect(test2.enqueued).toBe(true);

  // Peak same-team concurrency assertion: only the bootstrap task is Running;
  // the newly enqueued trigger task is Pending (not yet dequeued).
  const active = taskQueue.getActiveForTeam('ops-team');
  const running = active.filter(t => t.status === TaskStatus.Running);
  expect(running.length).toBeLessThanOrEqual(1);
});
