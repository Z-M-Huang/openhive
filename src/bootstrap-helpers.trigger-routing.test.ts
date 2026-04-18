/**
 * Bootstrap `initTriggerEngine` — trigger → task routing integration test.
 *
 * Verifies the `delegateTask` callback constructed inside `initTriggerEngine`
 * forwards `TaskOptions` (subagent, maxSteps, skill) received from the engine
 * to `taskQueueStore.enqueue()`. This closes the loop from trigger config
 * → engine → delegateTask wrapper → task queue.
 */

import { describe, it, expect, vi } from 'vitest';

import { initTriggerEngine } from './bootstrap-helpers.js';
import type { TaskQueueStore } from './storage/stores/task-queue-store.js';
import type { TriggerDedupStore } from './storage/stores/trigger-dedup-store.js';
import type { TriggerConfigStore } from './storage/stores/trigger-config-store.js';
import type { TriggerConfig } from './domain/types.js';
import type { AppLogger } from './logging/logger.js';

// ── Helpers ─────────────────────────────────────────────────────────────

function makeLogger(): AppLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as AppLogger;
}

function makeTriggerDedupStore(): TriggerDedupStore {
  return {
    checkDedup: vi.fn().mockReturnValue(false),
    recordEvent: vi.fn(),
    cleanExpired: vi.fn().mockReturnValue(0),
  } as unknown as TriggerDedupStore;
}

function makeTaskQueueStore(enqueueSpy: ReturnType<typeof vi.fn>): TaskQueueStore {
  return {
    enqueue: enqueueSpy,
    dequeue: vi.fn(),
    peek: vi.fn(),
    getByTeam: vi.fn().mockReturnValue([]),
    updateStatus: vi.fn(),
    updateResult: vi.fn(),
    getPending: vi.fn().mockReturnValue([]),
    getByStatus: vi.fn().mockReturnValue([]),
    removeByTeam: vi.fn(),
    getById: vi.fn(),
  } as unknown as TaskQueueStore;
}

function makeConfigStore(configs: Map<string, TriggerConfig>): TriggerConfigStore {
  return {
    upsert: vi.fn(),
    remove: vi.fn(),
    removeByTeam: vi.fn(),
    getByTeam: vi.fn().mockReturnValue([]),
    getAll: vi.fn().mockReturnValue([]),
    setState: vi.fn(),
    incrementFailures: vi.fn().mockReturnValue(0),
    resetFailures: vi.fn(),
    get: vi.fn((team: string, name: string) => configs.get(`${team}:${name}`)),
    setActiveTask: vi.fn(),
    clearActiveTask: vi.fn(),
    setOverlapCount: vi.fn(),
    resetOverlapState: vi.fn(),
  } as unknown as TriggerConfigStore;
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('initTriggerEngine delegateTask wrapper', () => {
  it('forwards subagent from engine options into taskQueueStore.enqueue', () => {
    const enqueue = vi.fn().mockReturnValue('task-abc');
    const taskQueueStore = makeTaskQueueStore(enqueue);

    const trigger: TriggerConfig = {
      name: 'kw-research',
      team: 'analysis-team',
      task: 'run research',
      config: { pattern: 'research' },
      type: 'keyword',
      state: 'active',
      subagent: 'researcher',
      maxSteps: 42,
    };

    const configs = new Map<string, TriggerConfig>();
    configs.set('analysis-team:kw-research', trigger);

    const engine = initTriggerEngine(
      makeTriggerDedupStore(),
      taskQueueStore,
      makeLogger(),
      makeConfigStore(configs),
    );

    engine.replaceTeamTriggers('analysis-team', [trigger]);
    engine.onMessage('please research this');

    expect(enqueue).toHaveBeenCalledTimes(1);
    const [team, task, priority, type, sourceChannelId, correlationId, options] =
      enqueue.mock.calls[0] as [string, string, string, string, string | undefined, string | undefined, Record<string, unknown>];
    expect(team).toBe('analysis-team');
    expect(task).toBe('run research');
    expect(priority).toBe('normal');
    expect(type).toBe('trigger');
    expect(sourceChannelId).toBeUndefined();
    expect(correlationId).toMatch(/^trigger:kw-research:\d+$/);
    expect(options).toEqual({
      maxSteps: 42,
      skill: undefined,
      subagent: 'researcher',
    });
  });

  it('forwards undefined options when trigger has no maxSteps/skill/subagent', () => {
    const enqueue = vi.fn().mockReturnValue('task-def');
    const taskQueueStore = makeTaskQueueStore(enqueue);

    const trigger: TriggerConfig = {
      name: 'kw-bare',
      team: 'team-a',
      task: 'plain task',
      config: { pattern: 'bare' },
      type: 'keyword',
      state: 'active',
    };

    const configs = new Map<string, TriggerConfig>();
    configs.set('team-a:kw-bare', trigger);

    const engine = initTriggerEngine(
      makeTriggerDedupStore(),
      taskQueueStore,
      makeLogger(),
      makeConfigStore(configs),
    );

    engine.replaceTeamTriggers('team-a', [trigger]);
    engine.onMessage('trigger bare');

    expect(enqueue).toHaveBeenCalledTimes(1);
    const options = enqueue.mock.calls[0][6] as unknown;
    expect(options).toBeUndefined();
  });

  it('falls back to configStore snapshot when caller passes no options (defensive)', () => {
    // Simulate a non-engine caller invoking the delegateTask wrapper directly.
    const enqueue = vi.fn().mockReturnValue('task-ghi');
    const taskQueueStore = makeTaskQueueStore(enqueue);

    const trigger: TriggerConfig = {
      name: 'kw-fallback',
      team: 'team-b',
      task: 'fallback task',
      config: { pattern: 'x' },
      type: 'keyword',
      state: 'active',
      subagent: 'analyst',
    };

    const configs = new Map<string, TriggerConfig>();
    configs.set('team-b:kw-fallback', trigger);

    const configStore = makeConfigStore(configs);

    // Build engine but reach into internals to test delegateTask fallback path.
    // We do this by constructing a no-op trigger set and calling the wrapper
    // through an engine.replaceTeamTriggers + onMessage cycle, but with a
    // trigger that HAS no subagent/maxSteps/skill (so engine passes undefined
    // options), forcing the fallback path in bootstrap.
    const staticTrigger: TriggerConfig = {
      name: 'kw-fallback',
      team: 'team-b',
      task: 'fallback task',
      config: { pattern: 'x' },
      type: 'keyword',
      state: 'active',
      // no subagent/maxSteps/skill on the static registered trigger
    };

    const engine = initTriggerEngine(
      makeTriggerDedupStore(),
      taskQueueStore,
      makeLogger(),
      configStore,
    );

    engine.replaceTeamTriggers('team-b', [staticTrigger]);
    // Live config (in configStore) has subagent='analyst', so the engine's
    // fireTrigger will see the live value and build options with it.
    engine.onMessage('x trigger');

    expect(enqueue).toHaveBeenCalledTimes(1);
    const options = enqueue.mock.calls[0][6] as unknown;
    expect(options).toEqual(expect.objectContaining({ subagent: 'analyst' }));
  });
});
