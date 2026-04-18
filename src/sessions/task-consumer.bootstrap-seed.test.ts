/**
 * Task consumer — post-bootstrap learning/reflection seeding (Bug #1).
 *
 * Verifies that on successful bootstrap task completion, the task consumer
 * invokes seedLearningTriggersForTeam so triggers are seeded only once
 * subagents have been authored to disk by the bootstrap task.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const mockHandleMessage = vi.fn().mockResolvedValue({ ok: true, content: 'bootstrapped', durationMs: 10 });
vi.mock('./message-handler.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./message-handler.js')>();
  return {
    ...orig,
    handleMessage: (...args: unknown[]): unknown => mockHandleMessage(...args),
  };
});

// Import AFTER mock definitions so the mocked module is used
import { TaskConsumer } from './task-consumer.js';
import type { TaskConsumerOpts } from './task-consumer.js';
import type { MessageHandlerDeps } from './message-handler.js';
import { createMockTaskQueue, createMemoryOrgStore } from '../handlers/__test-helpers.js';
import { OrgTree } from '../domain/org-tree.js';
import type { ITriggerConfigStore } from '../domain/interfaces.js';
import type { TriggerConfig } from '../domain/types.js';

class InMemoryTriggerStore implements ITriggerConfigStore {
  readonly rows = new Map<string, TriggerConfig>();
  private key(team: string, name: string): string { return `${team}::${name}`; }
  upsert(cfg: TriggerConfig): void { this.rows.set(this.key(cfg.team, cfg.name), { ...cfg }); }
  remove(team: string, name: string): void { this.rows.delete(this.key(team, name)); }
  removeByTeam(team: string): void {
    for (const k of [...this.rows.keys()]) if (k.startsWith(`${team}::`)) this.rows.delete(k);
  }
  get(team: string, name: string): TriggerConfig | undefined { return this.rows.get(this.key(team, name)); }
  getByTeam(team: string): TriggerConfig[] {
    return [...this.rows.values()].filter(r => r.team === team);
  }
  getAll(): TriggerConfig[] { return [...this.rows.values()]; }
  setState(): void { /* unused */ }
  incrementFailures(): number { return 0; }
  resetFailures(): void { /* unused */ }
  setActiveTask(): void { /* unused */ }
  clearActiveTask(): void { /* unused */ }
  setOverlapCount(): void { /* unused */ }
  resetOverlapState(): void { /* unused */ }
}

function createMockDeps(runDir: string, triggerConfigStore?: ITriggerConfigStore): MessageHandlerDeps {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    providers: {} as MessageHandlerDeps['providers'],
    runDir,
    dataDir: path.join(runDir, 'data'),
    systemRulesDir: path.join(runDir, 'rules'),
    orgAncestors: [],
    logger,
    triggerConfigStore,
  } as unknown as MessageHandlerDeps;
}

function makeConsumer(
  queue: ReturnType<typeof createMockTaskQueue>,
  deps: MessageHandlerDeps,
  teamId: string,
): TaskConsumer {
  const orgStore = createMemoryOrgStore();
  orgStore.addTeam({ teamId, name: teamId, parentId: null, status: 'idle', agents: [], children: [] } as Parameters<typeof orgStore.addTeam>[0]);
  const orgTree = new OrgTree(orgStore);
  const opts: TaskConsumerOpts = {
    taskQueueStore: queue,
    orgTree,
    handlerDeps: deps,
    pollIntervalMs: 1,
  };
  return new TaskConsumer(opts);
}

async function flushTick(consumer: TaskConsumer): Promise<void> {
  consumer.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  consumer.stop();
}

describe('TaskConsumer post-bootstrap trigger seeding (Bug #1)', () => {
  let runDir: string;
  let triggerStore: InMemoryTriggerStore;

  beforeEach(() => {
    mockHandleMessage.mockClear();
    mockHandleMessage.mockResolvedValue({ ok: true, content: 'bootstrapped', durationMs: 10 });
    runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhive-bootstrap-seed-'));
    triggerStore = new InMemoryTriggerStore();
  });

  afterEach(() => {
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  it('seeds per-subagent learning/reflection triggers on successful bootstrap completion', async () => {
    const subagentsDir = path.join(runDir, 'teams', 'ops-team', 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    fs.writeFileSync(path.join(subagentsDir, 'log-monitor.md'),
      '---\ndescription: monitors logs\n---\n# Agent: log-monitor\n');

    const queue = createMockTaskQueue();
    queue.enqueue('ops-team', 'bootstrap this team', 'critical', 'bootstrap');

    const deps = createMockDeps(runDir, triggerStore);
    const consumer = makeConsumer(queue, deps, 'ops-team');
    await flushTick(consumer);

    expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    const names = triggerStore.getByTeam('ops-team').map(r => r.name).sort();
    expect(names).toEqual(['learning-cycle-log-monitor', 'reflection-cycle-log-monitor']);
    // No generic rows for subagent-owning teams
    expect(triggerStore.get('ops-team', 'learning-cycle')).toBeUndefined();
    expect(triggerStore.get('ops-team', 'reflection-cycle')).toBeUndefined();
  });

  it('seeds generic rows when bootstrap finishes but team has zero subagents on disk', async () => {
    fs.mkdirSync(path.join(runDir, 'teams', 'barren-team', 'subagents'), { recursive: true });

    const queue = createMockTaskQueue();
    queue.enqueue('barren-team', 'bootstrap this team', 'critical', 'bootstrap');

    const deps = createMockDeps(runDir, triggerStore);
    const consumer = makeConsumer(queue, deps, 'barren-team');
    await flushTick(consumer);

    const rows = triggerStore.getByTeam('barren-team');
    expect(rows.map(r => r.name).sort()).toEqual(['learning-cycle', 'reflection-cycle']);
  });

  it('does not seed on failed bootstrap', async () => {
    mockHandleMessage.mockResolvedValueOnce({ ok: false, error: 'boom', durationMs: 10 });
    const subagentsDir = path.join(runDir, 'teams', 'doomed', 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    fs.writeFileSync(path.join(subagentsDir, 'agent.md'), '---\ndescription: x\n---\n# Agent: agent\n');

    const queue = createMockTaskQueue();
    queue.enqueue('doomed', 'bootstrap', 'critical', 'bootstrap');

    const deps = createMockDeps(runDir, triggerStore);
    const consumer = makeConsumer(queue, deps, 'doomed');
    await flushTick(consumer);

    expect(triggerStore.getByTeam('doomed')).toHaveLength(0);
  });

  it('is a no-op when triggerConfigStore is not provided', async () => {
    const subagentsDir = path.join(runDir, 'teams', 'no-store-team', 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    fs.writeFileSync(path.join(subagentsDir, 'agent.md'), '---\ndescription: x\n---\n# Agent: agent\n');

    const queue = createMockTaskQueue();
    queue.enqueue('no-store-team', 'bootstrap', 'critical', 'bootstrap');

    const deps = createMockDeps(runDir, undefined);
    const consumer = makeConsumer(queue, deps, 'no-store-team');
    await expect(flushTick(consumer)).resolves.not.toThrow();
  });

  it('does not seed for delegate tasks (only bootstrap triggers seeding)', async () => {
    const subagentsDir = path.join(runDir, 'teams', 'delegate-team', 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    fs.writeFileSync(path.join(subagentsDir, 'agent.md'), '---\ndescription: x\n---\n# Agent: agent\n');

    const queue = createMockTaskQueue();
    queue.enqueue('delegate-team', 'do the thing', 'normal', 'delegate');

    const deps = createMockDeps(runDir, triggerStore);
    const consumer = makeConsumer(queue, deps, 'delegate-team');
    await flushTick(consumer);

    expect(triggerStore.getByTeam('delegate-team')).toHaveLength(0);
  });
});
