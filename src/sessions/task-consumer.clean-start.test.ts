/**
 * Task consumer — clean-start subagent forwarding + validation.
 *
 * Verifies AC-15:
 *   1. `dequeued.options.subagent` flows to `handleMessage(..., { subagent })`
 *   2. An unknown subagent fails the task safely (status = Failed, no handleMessage call)
 *   3. Tasks without subagent options proceed normally with subagent=undefined
 *   4. Trigger-originated task with invalid subagent reports failure for circuit breaker
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock handleMessage (must be set up before importing task-consumer) ────

const mockHandleMessage = vi.fn().mockResolvedValue({ ok: true, content: 'ok', durationMs: 10 });
vi.mock('./message-handler.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./message-handler.js')>();
  return {
    ...orig,
    handleMessage: (...args: unknown[]) => mockHandleMessage(...args),
  };
});

// Import AFTER mock definitions so the mocked module is used
import { TaskConsumer } from './task-consumer.js';
import type { TaskConsumerOpts } from './task-consumer.js';
import type { SubagentDefinition } from './skill-loader.js';
import type { MessageHandlerDeps } from './message-handler.js';
import { createMockTaskQueue } from '../handlers/__test-helpers.js';
import { TaskStatus } from '../domain/types.js';
import type { TaskEntry } from '../domain/types.js';
import { OrgTree } from '../domain/org-tree.js';
import { createMemoryOrgStore } from '../handlers/__test-helpers.js';

// ── Test helpers ──────────────────────────────────────────────────────────

interface MockDeps extends MessageHandlerDeps {
  _mockLogger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> };
}

function createMockDeps(): MockDeps {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    providers: {} as MockDeps['providers'],
    runDir: '/tmp/test-run',
    dataDir: '/tmp/test-data',
    systemRulesDir: '/tmp/test-rules',
    orgAncestors: [],
    logger,
    _mockLogger: logger,
  } as unknown as MockDeps;
}

function seedTask(
  queue: ReturnType<typeof createMockTaskQueue>,
  overrides?: Partial<TaskEntry>,
): TaskEntry {
  const id = queue.enqueue(
    overrides?.teamId ?? 'weather-team',
    overrides?.task ?? 'check weather',
    overrides?.priority ?? 'normal',
    overrides?.type ?? 'trigger',
    overrides?.sourceChannelId ?? undefined,
    overrides?.correlationId ?? undefined,
    overrides?.options ?? undefined,
  );
  const entry = queue.getById(id)!;
  return entry;
}

function makeConsumer(
  queue: ReturnType<typeof createMockTaskQueue>,
  deps: MockDeps,
  subagents: Record<string, SubagentDefinition>,
  reportTriggerOutcome?: ReturnType<typeof vi.fn>,
): TaskConsumer {
  const orgStore = createMemoryOrgStore();
  orgStore.addTeam({ teamId: 'weather-team', name: 'weather-team', parentId: null, status: 'idle', agents: [], children: [] } as Parameters<typeof orgStore.addTeam>[0]);
  const orgTree = new OrgTree(orgStore);
  const opts: TaskConsumerOpts = {
    taskQueueStore: queue,
    orgTree,
    handlerDeps: deps,
    pollIntervalMs: 1,
    loadSubagents: vi.fn().mockReturnValue(subagents),
    reportTriggerOutcome,
  };
  return new TaskConsumer(opts);
}

async function flushTick(consumer: TaskConsumer): Promise<void> {
  consumer.start();
  // Allow the interval to fire and the async tick to complete
  await new Promise((resolve) => setTimeout(resolve, 30));
  consumer.stop();
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('TaskConsumer clean-start subagent forwarding', () => {
  beforeEach(() => {
    mockHandleMessage.mockClear();
    mockHandleMessage.mockResolvedValue({ ok: true, content: 'ok', durationMs: 10 });
  });

  it('forwards subagent from task options to handleMessage', async () => {
    const queue = createMockTaskQueue();
    const deps = createMockDeps();
    const subagents: Record<string, SubagentDefinition> = {
      'researcher': { description: 'Research topics', prompt: '# Agent: researcher' },
    };

    seedTask(queue, {
      options: { subagent: 'researcher' },
    });

    const consumer = makeConsumer(queue, deps, subagents);
    await flushTick(consumer);

    expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    const callArgs = mockHandleMessage.mock.calls[0];
    const opts = callArgs[2];
    expect(opts).toEqual(expect.objectContaining({
      teamName: 'weather-team',
      subagent: 'researcher',
    }));
  });

  it('fails task safely when subagent does not exist (no handleMessage call)', async () => {
    const queue = createMockTaskQueue();
    const deps = createMockDeps();
    const subagents: Record<string, SubagentDefinition> = {
      'researcher': { description: 'Research', prompt: '# Agent: researcher' },
    };

    const entry = seedTask(queue, {
      options: { subagent: 'missing-agent' },
    });

    const consumer = makeConsumer(queue, deps, subagents);
    await flushTick(consumer);

    // handleMessage must not be invoked
    expect(mockHandleMessage).not.toHaveBeenCalled();

    const final = queue.getById(entry.id)!;
    expect(final.status).toBe(TaskStatus.Failed);
    expect(final.result).toMatch(/Unknown subagent "missing-agent"/);
    expect(final.result).toMatch(/available: researcher/);
  });

  it('fails task safely with helpful hint when team has no subagents', async () => {
    const queue = createMockTaskQueue();
    const deps = createMockDeps();
    const subagents: Record<string, SubagentDefinition> = {};

    const entry = seedTask(queue, {
      options: { subagent: 'researcher' },
    });

    const consumer = makeConsumer(queue, deps, subagents);
    await flushTick(consumer);

    expect(mockHandleMessage).not.toHaveBeenCalled();
    const final = queue.getById(entry.id)!;
    expect(final.status).toBe(TaskStatus.Failed);
    expect(final.result).toMatch(/no subagents defined for this team/);
  });

  it('proceeds normally when task has no subagent in options', async () => {
    const queue = createMockTaskQueue();
    const deps = createMockDeps();

    seedTask(queue, {
      options: { maxSteps: 10 },
    });

    const consumer = makeConsumer(queue, deps, {});
    await flushTick(consumer);

    expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    const opts = mockHandleMessage.mock.calls[0][2];
    expect(opts.subagent).toBeUndefined();
    expect(opts.maxSteps).toBe(10);
  });

  it('reports trigger outcome as failure when subagent is invalid (circuit breaker)', async () => {
    const queue = createMockTaskQueue();
    const deps = createMockDeps();
    const reportTriggerOutcome = vi.fn();

    const entry = seedTask(queue, {
      type: 'trigger',
      correlationId: 'trigger:kw-broken:123456',
      options: { subagent: 'missing-agent' },
    });

    const consumer = makeConsumer(queue, deps, { 'good': { description: '', prompt: '' } }, reportTriggerOutcome);
    await flushTick(consumer);

    expect(mockHandleMessage).not.toHaveBeenCalled();
    expect(reportTriggerOutcome).toHaveBeenCalledWith('weather-team', 'kw-broken', false, entry.id);
  });

  it('does not call loadSubagents when task has no subagent (avoid unnecessary fs reads)', async () => {
    const queue = createMockTaskQueue();
    const deps = createMockDeps();
    const loadSubagentsSpy = vi.fn().mockReturnValue({});

    seedTask(queue, { options: { maxSteps: 5 } });

    const orgStore = createMemoryOrgStore();
    orgStore.addTeam({ teamId: 'weather-team', name: 'weather-team', parentId: null, status: 'idle', agents: [], children: [] } as Parameters<typeof orgStore.addTeam>[0]);
    const orgTree = new OrgTree(orgStore);
    const consumer = new TaskConsumer({
      taskQueueStore: queue,
      orgTree,
      handlerDeps: deps,
      pollIntervalMs: 1,
      loadSubagents: loadSubagentsSpy,
    });
    await flushTick(consumer);

    expect(loadSubagentsSpy).not.toHaveBeenCalled();
    expect(mockHandleMessage).toHaveBeenCalledTimes(1);
  });
});
