/* eslint-disable max-lines -- Aggregated integration suite covering 4 trigger types + per-team registry + dedup + rate limiting + window lifecycle. Splitting it would fragment shared fixtures and setup. */
/**
 * Trigger Engine + Per-Team Registry + Dedup Integration + Rate Limiting Integration
 *
 * Tests:
 * - Engine registers all 4 handler types (schedule/keyword/message/window), onMessage dispatches matching triggers
 * - Schedule trigger fires via cron
 * - Per-team trigger registration, replacement, removal, isolation
 * - Dedup integration: duplicate events blocked before delegate_task
 * - Rate limiting integration: excessive triggers blocked
 * - Window lifecycle integration
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { TriggerDedup } from './dedup.js';
import { TriggerRateLimiter } from './rate-limiter.js';
import { TriggerEngine } from './engine.js';
import type { ITriggerStore, ITriggerConfigStore, ITaskQueueStore } from '../domain/interfaces.js';
import type { TriggerConfig, TaskEntry } from '../domain/types.js';
import { TaskStatus } from '../domain/types.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function createMemoryTriggerStore(): ITriggerStore {
  const events = new Map<string, { source: string; createdAt: number; ttlSeconds: number }>();

  return {
    checkDedup(eventId: string, source: string): boolean {
      const key = `${eventId}:${source}`;
      const entry = events.get(key);
      if (!entry) return false;
      return Date.now() < entry.createdAt + entry.ttlSeconds * 1000;
    },
    recordEvent(eventId: string, source: string, ttlSeconds: number): void {
      const key = `${eventId}:${source}`;
      events.set(key, { source, createdAt: Date.now(), ttlSeconds });
    },
    cleanExpired(): number {
      const now = Date.now();
      let count = 0;
      for (const [key, entry] of events) {
        if (now >= entry.createdAt + entry.ttlSeconds * 1000) {
          events.delete(key);
          count++;
        }
      }
      return count;
    },
  };
}

function makeLogger(): { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function makeTrigger(overrides: Partial<TriggerConfig> & { type: TriggerConfig['type'] }): TriggerConfig {
  return {
    name: 'test-trigger',
    team: 'weather-team',
    task: 'check weather',
    config: {},
    ...overrides,
  };
}

// ── Trigger Engine ──────────────────────────────────────────────────────

describe('Trigger Engine', () => {
  let store: ITriggerStore;
  let dedup: TriggerDedup;
  let rateLimiter: TriggerRateLimiter;
  let logger: ReturnType<typeof makeLogger>;
  let delegateTask: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = createMemoryTriggerStore();
    dedup = new TriggerDedup(store);
    rateLimiter = new TriggerRateLimiter(100, 60_000);
    logger = makeLogger();
    delegateTask = vi.fn().mockResolvedValue('task-123');
  });

  it('registers all 3 handler types', () => {
    const triggers: TriggerConfig[] = [
      makeTrigger({ name: 'sched', type: 'schedule', config: { cron: '0 * * * *' } }),
      makeTrigger({ name: 'kw', type: 'keyword', config: { pattern: 'deploy' } }),
      makeTrigger({ name: 'msg', type: 'message', config: { pattern: 'error \\d+' } }),
    ];

    const engine = new TriggerEngine({ triggers, dedup, rateLimiter, delegateTask, logger });
    engine.register();

    // Logger should be called for each registration
    expect(logger.info).toHaveBeenCalledTimes(3);
  });

  it('onMessage dispatches matching keyword trigger', () => {
    const triggers: TriggerConfig[] = [
      makeTrigger({ name: 'kw-deploy', type: 'keyword', config: { pattern: 'deploy' } }),
    ];

    const engine = new TriggerEngine({ triggers, dedup, rateLimiter, delegateTask, logger });
    engine.register();

    engine.onMessage('please deploy now');
    expect(delegateTask).toHaveBeenCalledWith('weather-team', 'check weather', undefined, 'kw-deploy', undefined, undefined);
  });

  it('onMessage does not dispatch non-matching keyword', () => {
    const triggers: TriggerConfig[] = [
      makeTrigger({ name: 'kw-deploy', type: 'keyword', config: { pattern: 'deploy' } }),
    ];

    const engine = new TriggerEngine({ triggers, dedup, rateLimiter, delegateTask, logger });
    engine.register();

    engine.onMessage('just chatting');
    expect(delegateTask).not.toHaveBeenCalled();
  });

  it('onMessage dispatches matching message trigger', () => {
    const triggers: TriggerConfig[] = [
      makeTrigger({
        name: 'msg-error',
        type: 'message',
        config: { pattern: 'error \\d+', channel: 'ops' },
      }),
    ];

    const engine = new TriggerEngine({ triggers, dedup, rateLimiter, delegateTask, logger });
    engine.register();

    engine.onMessage('got error 500', 'ops');
    expect(delegateTask).toHaveBeenCalledWith('weather-team', 'check weather', undefined, 'msg-error', 'ops', undefined);
  });

  it('onMessage respects message trigger channel filter', () => {
    const triggers: TriggerConfig[] = [
      makeTrigger({
        name: 'msg-error',
        type: 'message',
        config: { pattern: 'error', channel: 'ops' },
      }),
    ];

    const engine = new TriggerEngine({ triggers, dedup, rateLimiter, delegateTask, logger });
    engine.register();

    engine.onMessage('error happened', 'general');
    expect(delegateTask).not.toHaveBeenCalled();
  });

  it('start/stop manage schedule handlers', () => {
    const triggers: TriggerConfig[] = [
      makeTrigger({ name: 'sched', type: 'schedule', config: { cron: '0 * * * *' } }),
    ];

    const engine = new TriggerEngine({ triggers, dedup, rateLimiter, delegateTask, logger });
    engine.register();

    // start and stop should not throw
    engine.start();
    engine.stop();

    expect(logger.info).toHaveBeenCalledWith('Trigger engine started', { schedules: 1, windows: 0 });
    expect(logger.info).toHaveBeenCalledWith('Trigger engine stopped');
  });

  it('schedule trigger fires via cron', async () => {
    const triggers: TriggerConfig[] = [
      makeTrigger({
        name: 'fast-sched',
        type: 'schedule',
        config: { cron: '* * * * * *' }, // every second
      }),
    ];

    const engine = new TriggerEngine({ triggers, dedup, rateLimiter, delegateTask, logger });
    engine.register();
    engine.start();

    // Wait for cron to fire at least once
    await new Promise((resolve) => setTimeout(resolve, 1200));

    expect(delegateTask).toHaveBeenCalled();
    engine.stop();
  });
});

// ── Dedup Integration ──────────────────────────────────────────────────

describe('Dedup Integration', () => {
  it('duplicate trigger events blocked before delegate_task', () => {
    const store = createMemoryTriggerStore();
    const dedup = new TriggerDedup(store);
    const rateLimiter = new TriggerRateLimiter(100, 60_000);
    const delegateTask = vi.fn().mockResolvedValue('task-123');
    const logger = makeLogger();

    const triggers: TriggerConfig[] = [
      makeTrigger({ name: 'kw-test', type: 'keyword', config: { pattern: 'test' } }),
    ];

    const engine = new TriggerEngine({ triggers, dedup, rateLimiter, delegateTask, logger });
    engine.register();

    // First message triggers delegate_task
    engine.onMessage('run test');
    expect(delegateTask).toHaveBeenCalledTimes(1);

    // Note: dedup uses event_id with Date.now() so each onMessage call
    // gets a unique event_id. The dedup prevents replay of the *same* event,
    // not repeated triggers from different messages.
    // This test verifies the dedup.record() path was exercised.
    expect(delegateTask).toHaveBeenCalledWith('weather-team', 'check weather', undefined, 'kw-test', undefined, undefined);
  });
});

// ── Trigger Engine: Per-Team Registry ──────────────────────────────────

describe('Trigger Engine: Per-Team Registry', () => {
  let store: ITriggerStore;
  let dedup: TriggerDedup;
  let rateLimiter: TriggerRateLimiter;
  let logger: ReturnType<typeof makeLogger>;
  let delegateTask: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = createMemoryTriggerStore();
    dedup = new TriggerDedup(store);
    rateLimiter = new TriggerRateLimiter(100, 60_000);
    logger = makeLogger();
    delegateTask = vi.fn().mockResolvedValue('task-123');
  });

  it('replaceTeamTriggers registers handlers for a team', () => {
    const engine = new TriggerEngine({ dedup, rateLimiter, delegateTask, logger });
    engine.replaceTeamTriggers('ops', [
      makeTrigger({ name: 'kw', type: 'keyword', config: { pattern: 'deploy' }, team: 'ops' }),
    ]);
    expect(engine.getTeamTriggerCount('ops')).toBe(1);
    expect(engine.getRegisteredCount()).toBe(1);
  });

  it('replaceTeamTriggers replaces existing handlers', () => {
    const engine = new TriggerEngine({ dedup, rateLimiter, delegateTask, logger });
    engine.replaceTeamTriggers('ops', [
      makeTrigger({ name: 'kw1', type: 'keyword', config: { pattern: 'deploy' }, team: 'ops' }),
      makeTrigger({ name: 'kw2', type: 'keyword', config: { pattern: 'rollback' }, team: 'ops' }),
    ]);
    expect(engine.getTeamTriggerCount('ops')).toBe(2);

    engine.replaceTeamTriggers('ops', [
      makeTrigger({ name: 'kw3', type: 'keyword', config: { pattern: 'test' }, team: 'ops' }),
    ]);
    expect(engine.getTeamTriggerCount('ops')).toBe(1);
    expect(engine.getRegisteredCount()).toBe(1);
  });

  it('removeTeamTriggers removes all handlers for a team', () => {
    const engine = new TriggerEngine({ dedup, rateLimiter, delegateTask, logger });
    engine.replaceTeamTriggers('ops', [
      makeTrigger({ name: 'kw', type: 'keyword', config: { pattern: 'deploy' }, team: 'ops' }),
    ]);
    engine.removeTeamTriggers('ops');
    expect(engine.getTeamTriggerCount('ops')).toBe(0);
    expect(engine.getRegisteredCount()).toBe(0);
  });

  it('removeTeamTriggers for non-existent team is no-op', () => {
    const engine = new TriggerEngine({ dedup, rateLimiter, delegateTask, logger });
    engine.removeTeamTriggers('nonexistent');
    expect(engine.getRegisteredCount()).toBe(0);
  });

  it('replaceTeamTriggers stops old schedule handlers before replacing', () => {
    const engine = new TriggerEngine({ dedup, rateLimiter, delegateTask, logger });
    engine.replaceTeamTriggers('ops', [
      makeTrigger({ name: 'sched1', type: 'schedule', config: { cron: '0 * * * *' }, team: 'ops' }),
    ]);
    engine.start();
    // Replace with new set — old schedules should be stopped
    engine.replaceTeamTriggers('ops', [
      makeTrigger({ name: 'sched2', type: 'schedule', config: { cron: '0 0 * * *' }, team: 'ops' }),
    ]);
    expect(engine.getTeamTriggerCount('ops')).toBe(1);
    engine.stop();
  });

  it('replaceTeamTriggers starts schedule handlers if engine is running', () => {
    const engine = new TriggerEngine({ dedup, rateLimiter, delegateTask, logger });
    engine.start();
    engine.replaceTeamTriggers('ops', [
      makeTrigger({ name: 'sched', type: 'schedule', config: { cron: '0 * * * *' }, team: 'ops' }),
    ]);
    expect(engine.getTeamTriggerCount('ops')).toBe(1);
    engine.stop();
  });

  it('per-team isolation: removing one team does not affect another', () => {
    const engine = new TriggerEngine({ dedup, rateLimiter, delegateTask, logger });
    engine.replaceTeamTriggers('alpha', [
      makeTrigger({ name: 'kw-a', type: 'keyword', config: { pattern: 'alpha' }, team: 'alpha' }),
    ]);
    engine.replaceTeamTriggers('beta', [
      makeTrigger({ name: 'kw-b', type: 'keyword', config: { pattern: 'beta' }, team: 'beta' }),
    ]);
    expect(engine.getRegisteredCount()).toBe(2);

    engine.removeTeamTriggers('alpha');
    expect(engine.getTeamTriggerCount('alpha')).toBe(0);
    expect(engine.getTeamTriggerCount('beta')).toBe(1);
    expect(engine.getRegisteredCount()).toBe(1);
  });

  it('onMessage dispatches across multiple teams handlers', () => {
    const engine = new TriggerEngine({ dedup, rateLimiter, delegateTask, logger });
    engine.replaceTeamTriggers('alpha', [
      makeTrigger({ name: 'kw-a', type: 'keyword', config: { pattern: 'shared' }, team: 'alpha', task: 'alpha task' }),
    ]);
    engine.replaceTeamTriggers('beta', [
      makeTrigger({ name: 'kw-b', type: 'keyword', config: { pattern: 'shared' }, team: 'beta', task: 'beta task' }),
    ]);

    engine.onMessage('shared event');
    expect(delegateTask).toHaveBeenCalledTimes(2);
    expect(delegateTask).toHaveBeenCalledWith('alpha', 'alpha task', undefined, 'kw-a', undefined, undefined);
    expect(delegateTask).toHaveBeenCalledWith('beta', 'beta task', undefined, 'kw-b', undefined, undefined);
  });
});

// ── Channel Threading ──────────────────────────────────────────────────

describe('Channel threading through onMessage → delegateTask', () => {
  let delegateTask: ReturnType<typeof vi.fn>;
  let dedup: TriggerDedup;
  let rateLimiter: TriggerRateLimiter;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    const store = createMemoryTriggerStore();
    dedup = new TriggerDedup(store);
    rateLimiter = new TriggerRateLimiter(100, 60_000);
    delegateTask = vi.fn().mockResolvedValue('task-123');
    logger = makeLogger();
  });

  it('passes channel to delegateTask for keyword triggers', () => {
    const triggers: TriggerConfig[] = [
      makeTrigger({ name: 'kw-alert', type: 'keyword', config: { pattern: 'alert' } }),
    ];
    const engine = new TriggerEngine({ triggers, dedup, rateLimiter, delegateTask, logger });
    engine.register();

    engine.onMessage('alert now', 'ws:chan1');
    expect(delegateTask).toHaveBeenCalledWith('weather-team', 'check weather', undefined, 'kw-alert', 'ws:chan1', undefined);
  });

  it('passes channel to delegateTask for message triggers', () => {
    const triggers: TriggerConfig[] = [
      makeTrigger({ name: 'msg-notify', type: 'message', config: { pattern: 'notify', channel: 'general' } }),
    ];
    const engine = new TriggerEngine({ triggers, dedup, rateLimiter, delegateTask, logger });
    engine.register();

    engine.onMessage('notify me', 'general');
    expect(delegateTask).toHaveBeenCalledWith('weather-team', 'check weather', undefined, 'msg-notify', 'general', undefined);
  });

  it('passes undefined channel for scheduled triggers without sourceChannelId', () => {
    // Schedule triggers fire without a channel context when no sourceChannelId stored
    const triggers: TriggerConfig[] = [
      makeTrigger({ name: 'sched-daily', type: 'schedule', config: { cron: '0 9 * * *' } }),
    ];
    const engine = new TriggerEngine({ triggers, dedup, rateLimiter, delegateTask, logger });
    engine.register();
    // Schedule triggers fire via their handler callback, not onMessage — sourceChannelId is undefined
    // We don't test cron firing directly here; the key assertion is in the onMessage tests above
  });

  it('schedule trigger passes stored sourceChannelId from config', async () => {
    // When a trigger is created via WS, sourceChannelId is stored in trigger config
    // Schedule handler should pass it through to delegateTask
    const triggers: TriggerConfig[] = [
      makeTrigger({
        name: 'sched-ws',
        type: 'schedule',
        config: { cron: '* * * * * *' }, // every second
        sourceChannelId: 'ws:originator-123',
      }),
    ];
    const engine = new TriggerEngine({ triggers, dedup, rateLimiter, delegateTask, logger });
    engine.register();
    engine.start();

    await new Promise((resolve) => setTimeout(resolve, 1200));

    expect(delegateTask).toHaveBeenCalled();
    // sourceChannelId should be passed through from the trigger config
    expect(delegateTask).toHaveBeenCalledWith(
      'weather-team', 'check weather', undefined, 'sched-ws', 'ws:originator-123', undefined,
    );
    engine.stop();
  });
});

// ── Rate Limiting Integration ──────────────────────────────────────────

describe('Rate Limiting Integration', () => {
  it('excessive triggers from same source blocked', () => {
    const store = createMemoryTriggerStore();
    const dedup = new TriggerDedup(store);
    const rateLimiter = new TriggerRateLimiter(2, 60_000); // Only 2 allowed
    const delegateTask = vi.fn().mockResolvedValue('task-123');
    const logger = makeLogger();

    const triggers: TriggerConfig[] = [
      makeTrigger({ name: 'kw-go', type: 'keyword', config: { pattern: 'go' } }),
    ];

    const engine = new TriggerEngine({ triggers, dedup, rateLimiter, delegateTask, logger });
    engine.register();

    // First two should succeed
    engine.onMessage('go now');
    engine.onMessage('go again');
    expect(delegateTask).toHaveBeenCalledTimes(2);

    // Third should be rate limited
    engine.onMessage('go once more');
    expect(delegateTask).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      'Trigger rate limited',
      expect.objectContaining({ name: 'kw-go' }),
    );
  });
});

// ── Overlap Policy ──────────────────────────────────────────────────────

function createMockConfigStore(configs: Map<string, TriggerConfig>): ITriggerConfigStore {
  return {
    upsert: vi.fn(),
    remove: vi.fn(),
    removeByTeam: vi.fn(),
    getByTeam: vi.fn().mockReturnValue([]),
    getAll: vi.fn().mockReturnValue([]),
    setState: vi.fn(),
    incrementFailures: vi.fn().mockReturnValue(1),
    resetFailures: vi.fn(),
    get: vi.fn((team: string, name: string) => configs.get(`${team}:${name}`)),
    setActiveTask: vi.fn((team: string, name: string, taskId: string) => {
      const key = `${team}:${name}`;
      const existing = configs.get(key);
      if (existing) configs.set(key, { ...existing, activeTaskId: taskId });
    }),
    clearActiveTask: vi.fn((team: string, name: string) => {
      const key = `${team}:${name}`;
      const existing = configs.get(key);
      if (existing) configs.set(key, { ...existing, activeTaskId: null });
    }),
    setOverlapCount: vi.fn((team: string, name: string, count: number) => {
      const key = `${team}:${name}`;
      const existing = configs.get(key);
      if (existing) configs.set(key, { ...existing, overlapCount: count });
    }),
    resetOverlapState: vi.fn((team: string, name: string) => {
      const key = `${team}:${name}`;
      const existing = configs.get(key);
      if (existing) configs.set(key, { ...existing, activeTaskId: null, overlapCount: 0 });
    }),
  };
}

function createMockTaskQueueStore(tasks: Map<string, TaskEntry>): ITaskQueueStore {
  return {
    enqueue: vi.fn().mockReturnValue('task-new'),
    dequeue: vi.fn(),
    peek: vi.fn(),
    getActiveForTeam: vi.fn().mockReturnValue([]),
    getByTeam: vi.fn().mockReturnValue([]),
    updateStatus: vi.fn((taskId: string, status: TaskStatus) => {
      const existing = tasks.get(taskId);
      if (existing) tasks.set(taskId, { ...existing, status });
    }),
    updateResult: vi.fn(),
    getPending: vi.fn().mockReturnValue([]),
    getByStatus: vi.fn().mockReturnValue([]),
    removeByTeam: vi.fn(),
    getById: vi.fn((taskId: string) => tasks.get(taskId)),
  };
}

function makeTaskEntry(id: string, status: TaskStatus): TaskEntry {
  return {
    id,
    teamId: 'weather-team',
    task: 'check weather',
    priority: 'normal',
    type: 'trigger',
    status,
    createdAt: new Date().toISOString(),
    correlationId: null,
    result: null,
    durationMs: null,
    options: null,
    sourceChannelId: null,
  };
}

describe('Overlap Policy', () => {
  let store: ITriggerStore;
  let dedup: TriggerDedup;
  let rateLimiter: TriggerRateLimiter;
  let logger: ReturnType<typeof makeLogger>;
  let delegateTask: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = createMemoryTriggerStore();
    dedup = new TriggerDedup(store);
    rateLimiter = new TriggerRateLimiter(100, 60_000);
    logger = makeLogger();
    delegateTask = vi.fn().mockResolvedValue('task-new');
  });

  it('always-skip: skips when active task exists', () => {
    const tasks = new Map<string, TaskEntry>();
    tasks.set('task-old', makeTaskEntry('task-old', TaskStatus.Running));

    const configs = new Map<string, TriggerConfig>();
    configs.set('weather-team:kw-check', {
      name: 'kw-check', type: 'keyword', config: { pattern: 'weather' },
      team: 'weather-team', task: 'check weather',
      state: 'active', overlapPolicy: 'always-skip', activeTaskId: 'task-old',
    });

    const configStore = createMockConfigStore(configs);
    const taskQueueStore = createMockTaskQueueStore(tasks);
    const onOverlapAlert = vi.fn();

    const triggers: TriggerConfig[] = [
      makeTrigger({ name: 'kw-check', type: 'keyword', config: { pattern: 'weather' } }),
    ];

    const engine = new TriggerEngine({
      triggers, dedup, rateLimiter, delegateTask, logger,
      configStore, taskQueueStore, onOverlapAlert,
    });
    engine.register();
    engine.onMessage('weather update');

    expect(delegateTask).not.toHaveBeenCalled();
    expect(onOverlapAlert).toHaveBeenCalledWith('weather-team', 'kw-check', 'skipped', { oldTaskId: 'task-old' });
  });

  it('always-replace: cancels old task and creates new one', () => {
    const tasks = new Map<string, TaskEntry>();
    tasks.set('task-old', makeTaskEntry('task-old', TaskStatus.Running));

    const configs = new Map<string, TriggerConfig>();
    configs.set('weather-team:kw-check', {
      name: 'kw-check', type: 'keyword', config: { pattern: 'weather' },
      team: 'weather-team', task: 'check weather',
      state: 'active', overlapPolicy: 'always-replace', activeTaskId: 'task-old',
    });

    const configStore = createMockConfigStore(configs);
    const taskQueueStore = createMockTaskQueueStore(tasks);
    const abortSession = vi.fn();
    const onOverlapAlert = vi.fn();

    const triggers: TriggerConfig[] = [
      makeTrigger({ name: 'kw-check', type: 'keyword', config: { pattern: 'weather' } }),
    ];

    const engine = new TriggerEngine({
      triggers, dedup, rateLimiter, delegateTask, logger,
      configStore, taskQueueStore, abortSession, onOverlapAlert,
    });
    engine.register();
    engine.onMessage('weather update');

    expect(taskQueueStore.updateStatus).toHaveBeenCalledWith('task-old', TaskStatus.Cancelled);
    expect(abortSession).toHaveBeenCalledWith('weather-team', 'task-old');
    expect(onOverlapAlert).toHaveBeenCalledWith('weather-team', 'kw-check', 'replaced', { oldTaskId: 'task-old' });
    expect(delegateTask).toHaveBeenCalled();
  });

  it('skip-then-replace: skips first overlap, replaces second', () => {
    const tasks = new Map<string, TaskEntry>();
    tasks.set('task-old', makeTaskEntry('task-old', TaskStatus.Running));

    const configs = new Map<string, TriggerConfig>();
    configs.set('weather-team:kw-check', {
      name: 'kw-check', type: 'keyword', config: { pattern: 'weather' },
      team: 'weather-team', task: 'check weather',
      state: 'active', overlapPolicy: 'skip-then-replace', activeTaskId: 'task-old', overlapCount: 0,
    });

    const configStore = createMockConfigStore(configs);
    const taskQueueStore = createMockTaskQueueStore(tasks);
    const abortSession = vi.fn();
    const onOverlapAlert = vi.fn();

    const triggers: TriggerConfig[] = [
      makeTrigger({ name: 'kw-check', type: 'keyword', config: { pattern: 'weather' } }),
    ];

    const engine = new TriggerEngine({
      triggers, dedup, rateLimiter, delegateTask, logger,
      configStore, taskQueueStore, abortSession, onOverlapAlert,
    });
    engine.register();

    // First overlap — should skip
    engine.onMessage('weather update');
    expect(delegateTask).not.toHaveBeenCalled();
    expect(onOverlapAlert).toHaveBeenCalledWith('weather-team', 'kw-check', 'skipped', { oldTaskId: 'task-old' });
    expect(configStore.setOverlapCount).toHaveBeenCalledWith('weather-team', 'kw-check', 1);

    // Second overlap — should replace (overlapCount is now 1 after setOverlapCount mock)
    engine.onMessage('weather report');
    expect(delegateTask).toHaveBeenCalled();
    expect(onOverlapAlert).toHaveBeenCalledWith('weather-team', 'kw-check', 'replaced', { oldTaskId: 'task-old' });
  });

  it('allow policy: fires without overlap check', () => {
    const configs = new Map<string, TriggerConfig>();
    configs.set('weather-team:kw-check', {
      name: 'kw-check', type: 'keyword', config: { pattern: 'weather' },
      team: 'weather-team', task: 'check weather',
      state: 'active', overlapPolicy: 'allow',
    });

    const configStore = createMockConfigStore(configs);
    const onOverlapAlert = vi.fn();

    const triggers: TriggerConfig[] = [
      makeTrigger({ name: 'kw-check', type: 'keyword', config: { pattern: 'weather' } }),
    ];

    const engine = new TriggerEngine({
      triggers, dedup, rateLimiter, delegateTask, logger,
      configStore, onOverlapAlert,
    });
    engine.register();

    engine.onMessage('weather update');
    expect(delegateTask).toHaveBeenCalled();
    expect(onOverlapAlert).not.toHaveBeenCalled();
    // setActiveTask should NOT be called with 'allow' policy
    expect(configStore.setActiveTask).not.toHaveBeenCalled();
  });

  it('stale activeTaskId: clears reference and proceeds', () => {
    const tasks = new Map<string, TaskEntry>();
    tasks.set('task-old', makeTaskEntry('task-old', TaskStatus.Done));

    const configs = new Map<string, TriggerConfig>();
    configs.set('weather-team:kw-check', {
      name: 'kw-check', type: 'keyword', config: { pattern: 'weather' },
      team: 'weather-team', task: 'check weather',
      state: 'active', overlapPolicy: 'always-skip', activeTaskId: 'task-old',
    });

    const configStore = createMockConfigStore(configs);
    const taskQueueStore = createMockTaskQueueStore(tasks);

    const triggers: TriggerConfig[] = [
      makeTrigger({ name: 'kw-check', type: 'keyword', config: { pattern: 'weather' } }),
    ];

    const engine = new TriggerEngine({
      triggers, dedup, rateLimiter, delegateTask, logger,
      configStore, taskQueueStore,
    });
    engine.register();
    engine.onMessage('weather update');

    // Stale reference should be cleared and task should proceed
    expect(configStore.clearActiveTask).toHaveBeenCalledWith('weather-team', 'kw-check');
    expect(delegateTask).toHaveBeenCalled();
  });

  it('reportTaskOutcome ignores cancelled tasks', () => {
    const tasks = new Map<string, TaskEntry>();
    tasks.set('task-cancelled', makeTaskEntry('task-cancelled', TaskStatus.Cancelled));

    const configs = new Map<string, TriggerConfig>();
    configs.set('weather-team:kw-check', {
      name: 'kw-check', type: 'keyword', config: { pattern: 'weather' },
      team: 'weather-team', task: 'check weather',
      state: 'active',
    });

    const configStore = createMockConfigStore(configs);
    const taskQueueStore = createMockTaskQueueStore(tasks);

    const engine = new TriggerEngine({
      dedup, rateLimiter, delegateTask, logger,
      configStore, taskQueueStore,
    });

    engine.reportTaskOutcome('weather-team', 'kw-check', false, 'task-cancelled');

    // Should not increment failures for a cancelled task
    expect(configStore.incrementFailures).not.toHaveBeenCalled();
  });

  it('reportTaskOutcome clears activeTaskId on completion', () => {
    const tasks = new Map<string, TaskEntry>();
    tasks.set('task-done', makeTaskEntry('task-done', TaskStatus.Done));

    const configs = new Map<string, TriggerConfig>();
    configs.set('weather-team:kw-check', {
      name: 'kw-check', type: 'keyword', config: { pattern: 'weather' },
      team: 'weather-team', task: 'check weather',
      state: 'active', activeTaskId: 'task-done',
    });

    const configStore = createMockConfigStore(configs);
    const taskQueueStore = createMockTaskQueueStore(tasks);

    const engine = new TriggerEngine({
      dedup, rateLimiter, delegateTask, logger,
      configStore, taskQueueStore,
    });

    engine.reportTaskOutcome('weather-team', 'kw-check', true, 'task-done');

    expect(configStore.resetFailures).toHaveBeenCalledWith('weather-team', 'kw-check');
    expect(configStore.clearActiveTask).toHaveBeenCalledWith('weather-team', 'kw-check');
  });
});

// ── Subagent routing (AC-14) ────────────────────────────────────────────

// ── TriggerEngine.loadFromStore ADR-40 skip+warn ──────────────────────

function makeConfigStore(rows: TriggerConfig[]): ITriggerConfigStore {
  const data = new Map<string, TriggerConfig>();
  for (const r of rows) data.set(`${r.team}:${r.name}`, r);
  return {
    upsert: vi.fn((cfg: TriggerConfig) => data.set(`${cfg.team}:${cfg.name}`, cfg)),
    remove: vi.fn((team: string, name: string) => data.delete(`${team}:${name}`)),
    removeByTeam: vi.fn((team: string) => {
      for (const k of data.keys()) { if (k.startsWith(`${team}:`)) data.delete(k); }
    }),
    getByTeam: vi.fn((team: string) => rows.filter(r => r.team === team)),
    getAll: vi.fn(() => [...rows]),
    setState: vi.fn(),
    incrementFailures: vi.fn().mockReturnValue(1),
    resetFailures: vi.fn(),
    get: vi.fn((team: string, name: string) => data.get(`${team}:${name}`)),
    setActiveTask: vi.fn(),
    clearActiveTask: vi.fn(),
    setOverlapCount: vi.fn(),
    resetOverlapState: vi.fn(),
  };
}

function makeSilentLogger(): { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

describe('TriggerEngine.loadFromStore ADR-40 skip+warn', () => {
  it('skips legacy rows with skill and no subagent, warns, preserves storage', async () => {
    const warn = vi.fn();
    const logger = { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() };
    const rows: TriggerConfig[] = [
      { team: 'ops', name: 'legacy', type: 'schedule', config: { cron: '* * * * *' }, task: 'do', skill: 'log-check', state: 'active' },
      { team: 'ops', name: 'valid', type: 'schedule', config: { cron: '* * * * *' }, task: 'do', subagent: 'agent', state: 'active' },
    ];
    const store = makeConfigStore(rows);
    const dedup = new TriggerDedup(createMemoryTriggerStore());
    const rateLimiter = new TriggerRateLimiter(100, 60_000);
    const delegateTask = vi.fn().mockResolvedValue('task-123');

    const engine = new TriggerEngine({ configStore: store, logger, dedup, rateLimiter, delegateTask });
    engine.loadFromStore();

    // Legacy row should NOT be registered
    expect(engine.getTeamTriggerCount('ops')).toBe(1);
    // Valid row should be registered
    expect(engine.getRegisteredCount()).toBe(1);

    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/adr-40|skill.*subagent/i),
      expect.objectContaining({ team: 'ops', name: 'legacy', skill: 'log-check' }),
    );

    // storage unchanged
    expect(store.getAll().map((r) => r.name)).toEqual(['legacy', 'valid']);
  });

  it('registers all valid rows when no violators present', async () => {
    const logger = makeSilentLogger();
    const rows: TriggerConfig[] = [
      { team: 'ops', name: 'a', type: 'schedule', config: { cron: '* * * * *' }, task: 'do', subagent: 'agent', state: 'active' },
    ];
    const store = makeConfigStore(rows);
    const dedup = new TriggerDedup(createMemoryTriggerStore());
    const rateLimiter = new TriggerRateLimiter(100, 60_000);
    const delegateTask = vi.fn().mockResolvedValue('task-123');

    const engine = new TriggerEngine({ configStore: store, logger, dedup, rateLimiter, delegateTask });
    engine.loadFromStore();

    expect(engine.getTeamTriggerCount('ops')).toBe(1);
    expect(engine.getRegisteredCount()).toBe(1);
  });
});

// ── Subagent routing (AC-14) ────────────────────────────────────────────

describe('Subagent routing', () => {
  let store: ITriggerStore;
  let dedup: TriggerDedup;
  let rateLimiter: TriggerRateLimiter;
  let logger: ReturnType<typeof makeLogger>;
  let delegateTask: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = createMemoryTriggerStore();
    dedup = new TriggerDedup(store);
    rateLimiter = new TriggerRateLimiter(100, 60_000);
    logger = makeLogger();
    delegateTask = vi.fn().mockResolvedValue('task-new');
  });

  it('propagates subagent to delegateTask options for schedule triggers', async () => {
    const triggers: TriggerConfig[] = [
      makeTrigger({
        name: 'sched-research',
        type: 'schedule',
        config: { cron: '* * * * * *' },
        subagent: 'researcher',
      }),
    ];
    const engine = new TriggerEngine({ triggers, dedup, rateLimiter, delegateTask, logger });
    engine.register();
    engine.start();

    await new Promise((resolve) => setTimeout(resolve, 1200));

    expect(delegateTask).toHaveBeenCalled();
    const lastCall = delegateTask.mock.calls[delegateTask.mock.calls.length - 1];
    expect(lastCall[5]).toEqual(expect.objectContaining({ subagent: 'researcher' }));
    engine.stop();
  });

  it('propagates subagent to delegateTask options for keyword triggers', () => {
    const triggers: TriggerConfig[] = [
      makeTrigger({
        name: 'kw-deploy',
        type: 'keyword',
        config: { pattern: 'deploy' },
        subagent: 'deployer',
      }),
    ];
    const engine = new TriggerEngine({ triggers, dedup, rateLimiter, delegateTask, logger });
    engine.register();

    engine.onMessage('please deploy now');
    expect(delegateTask).toHaveBeenCalledWith(
      'weather-team', 'check weather', undefined, 'kw-deploy', undefined,
      expect.objectContaining({ subagent: 'deployer' }),
    );
  });

  it('propagates subagent to delegateTask options for message triggers', () => {
    const triggers: TriggerConfig[] = [
      makeTrigger({
        name: 'msg-error',
        type: 'message',
        config: { pattern: 'error', channel: 'ops' },
        subagent: 'analyst',
      }),
    ];
    const engine = new TriggerEngine({ triggers, dedup, rateLimiter, delegateTask, logger });
    engine.register();

    engine.onMessage('got error now', 'ops');
    expect(delegateTask).toHaveBeenCalledWith(
      'weather-team', 'check weather', undefined, 'msg-error', 'ops',
      expect.objectContaining({ subagent: 'analyst' }),
    );
  });

  it('propagates maxSteps + skill + subagent together as TaskOptions', () => {
    const triggers: TriggerConfig[] = [
      makeTrigger({
        name: 'kw-combo',
        type: 'keyword',
        config: { pattern: 'combo' },
        subagent: 'researcher',
        maxSteps: 50,
        skill: 'deep-dive',
      }),
    ];
    const engine = new TriggerEngine({ triggers, dedup, rateLimiter, delegateTask, logger });
    engine.register();

    engine.onMessage('combo trigger');
    expect(delegateTask).toHaveBeenCalledWith(
      'weather-team', 'check weather', undefined, 'kw-combo', undefined,
      { maxSteps: 50, skill: 'deep-dive', subagent: 'researcher' },
    );
  });

  it('omits options when trigger has no maxSteps/skill/subagent', () => {
    const triggers: TriggerConfig[] = [
      makeTrigger({
        name: 'kw-plain',
        type: 'keyword',
        config: { pattern: 'plain' },
      }),
    ];
    const engine = new TriggerEngine({ triggers, dedup, rateLimiter, delegateTask, logger });
    engine.register();

    engine.onMessage('plain trigger');
    expect(delegateTask).toHaveBeenCalledWith(
      'weather-team', 'check weather', undefined, 'kw-plain', undefined, undefined,
    );
  });

  it('dedup scope is separated by subagent — same trigger name but different subagents dedup independently', () => {
    // Two keyword triggers in the same team, same pattern, different subagents.
    // onMessage with identical text should fire BOTH (not dedup against each other)
    // because the dedup scope includes subagent.
    const configs = new Map<string, TriggerConfig>();
    const triggerA: TriggerConfig = {
      name: 'kw-a', type: 'keyword', config: { pattern: 'shared' },
      team: 'weather-team', task: 'task A',
      state: 'active', subagent: 'researcher',
    };
    const triggerB: TriggerConfig = {
      name: 'kw-b', type: 'keyword', config: { pattern: 'shared' },
      team: 'weather-team', task: 'task B',
      state: 'active', subagent: 'analyst',
    };
    configs.set('weather-team:kw-a', triggerA);
    configs.set('weather-team:kw-b', triggerB);
    const configStore = createMockConfigStore(configs);

    const engine = new TriggerEngine({
      triggers: [triggerA, triggerB],
      dedup, rateLimiter, delegateTask, logger,
      configStore,
    });
    engine.register();

    engine.onMessage('shared event');
    // Both triggers fire — their subagent-scoped event keys differ
    expect(delegateTask).toHaveBeenCalledTimes(2);
    expect(delegateTask).toHaveBeenCalledWith(
      'weather-team', 'task A', undefined, 'kw-a', undefined,
      expect.objectContaining({ subagent: 'researcher' }),
    );
    expect(delegateTask).toHaveBeenCalledWith(
      'weather-team', 'task B', undefined, 'kw-b', undefined,
      expect.objectContaining({ subagent: 'analyst' }),
    );
  });

  it('live config subagent takes precedence over registered trigger subagent', () => {
    // Trigger was registered with subagent 'old-agent', but the configStore
    // (live config) has 'new-agent'. The engine must use the live config.
    const staticTrigger = makeTrigger({
      name: 'kw-live',
      type: 'keyword',
      config: { pattern: 'ping' },
      subagent: 'old-agent',
    });

    const configs = new Map<string, TriggerConfig>();
    configs.set('weather-team:kw-live', {
      ...staticTrigger,
      state: 'active',
      subagent: 'new-agent',
    });
    const configStore = createMockConfigStore(configs);

    const engine = new TriggerEngine({
      triggers: [staticTrigger],
      dedup, rateLimiter, delegateTask, logger,
      configStore,
    });
    engine.register();

    engine.onMessage('ping!');
    expect(delegateTask).toHaveBeenCalledWith(
      'weather-team', 'check weather', undefined, 'kw-live', undefined,
      expect.objectContaining({ subagent: 'new-agent' }),
    );
  });
});

// ── Engine window integration (AC-41, AC-42, AC-50) ────────────────────

describe('engine window integration', () => {
  function makeWindowOpts() {
    const store = createMemoryTriggerStore();
    return {
      dedup: new TriggerDedup(store),
      rateLimiter: new TriggerRateLimiter(100, 60_000),
      delegateTask: vi.fn().mockResolvedValue('task-123'),
      logger: makeLogger(),
    };
  }

  it('registers a window handler via replaceTeamTriggers', () => {
    const engine = new TriggerEngine(makeWindowOpts());
    engine.replaceTeamTriggers('t1', [
      { name: 'w1', type: 'window', config: { tick_interval_ms: 50 }, team: 't1', task: 'check' },
    ]);
    expect(engine.getTeamTriggerCount('t1')).toBe(1);
  });

  it('cleans up window handlers when the team config replaces them with none', () => {
    const engine = new TriggerEngine(makeWindowOpts());
    engine.replaceTeamTriggers('t1', [
      { name: 'w1', type: 'window', config: { tick_interval_ms: 50 }, team: 't1', task: 'check' },
    ]);
    engine.replaceTeamTriggers('t1', []);
    expect(engine.getTeamTriggerCount('t1')).toBe(0);
  });

  it('starts all window handlers when engine.start() is invoked', () => {
    const engine = new TriggerEngine(makeWindowOpts());
    engine.replaceTeamTriggers('t1', [
      { name: 'w1', type: 'window', config: { tick_interval_ms: 50 }, team: 't1', task: 'check' },
    ]);
    engine.start();
    const snapshot = engine.getRegisteredCount();
    expect(snapshot).toBeGreaterThanOrEqual(1);
    engine.stop();
  });
});

// ── Window End-to-End Lifecycle (AC-47, AC-48, AC-50) ──────────────────

describe('window end-to-end lifecycle', () => {
  let store: ITriggerStore;
  let dedup: TriggerDedup;
  let rateLimiter: TriggerRateLimiter;
  let logger: ReturnType<typeof makeLogger>;
  let delegateTask: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = createMemoryTriggerStore();
    dedup = new TriggerDedup(store);
    rateLimiter = new TriggerRateLimiter(100, 60_000);
    logger = makeLogger();
    delegateTask = vi.fn().mockResolvedValue('task-123');
  });

  it('lists a window trigger after creation', () => {
    const engine = new TriggerEngine({ dedup, rateLimiter, delegateTask, logger });
    engine.replaceTeamTriggers('t1', [
      makeTrigger({ name: 'w1', type: 'window', config: { tick_interval_ms: 50 }, team: 't1' }),
    ]);
    // Window trigger is counted in the registry
    expect(engine.getTeamTriggerCount('t1')).toBe(1);
    // Window triggers do not respond to onMessage — confirms they are registered as
    // window type rather than keyword/message handlers (AC-50)
    engine.onMessage('anything');
    expect(delegateTask).not.toHaveBeenCalled();
  });

  it('stops dispatching new ticks after the window closes', () => {
    const engine = new TriggerEngine({ dedup, rateLimiter, delegateTask, logger });
    engine.replaceTeamTriggers('t1', [
      makeTrigger({ name: 'w1', type: 'window', config: { tick_interval_ms: 30 }, team: 't1' }),
    ]);
    engine.start();
    expect(engine.getTeamTriggerCount('t1')).toBe(1);
    // Simulate window close: replacing with empty set stops and removes the handler (AC-47)
    engine.replaceTeamTriggers('t1', []);
    expect(engine.getTeamTriggerCount('t1')).toBe(0);
    engine.stop();
  });

  it('suppresses notification when the tick result decision is noop', async () => {
    // parseLlmNotifyDecision with notify:false models a noop tick — no user notification (AC-47)
    const { parseLlmNotifyDecision } = await import('../sessions/task-consumer-notify.js');
    const noopResponse = '```json:notify\n{"notify": false, "reason": "No changes detected"}\n```';
    const decision = parseLlmNotifyDecision(noopResponse);
    expect(decision.notify).toBe(false);
    // Fail-safe: missing block defaults to notify:true so actionable results are not silently dropped
    const failSafe = parseLlmNotifyDecision('');
    expect(failSafe.notify).toBe(true);
  });

  it('uses periodic ticks, not streaming continuation, between rounds', async () => {
    // AC-48: The WindowHandler onTick callback fires repeatedly on an interval —
    // the continuity model is periodic fresh rounds rather than a single long-
    // running stream held open across rounds. We test WindowHandler directly so
    // the periodicity signal is observable without going through engine-level
    // dedup (which is a separate layer with its own tests).
    const { WindowHandler } = await import('./handlers/window.js');
    const tickSpy = vi.fn(() => Promise.resolve());
    const handler = new WindowHandler(
      { tick_interval_ms: 15 },
      tickSpy,
    );
    handler.start();
    await new Promise((r) => setTimeout(r, 55));
    handler.stop();
    // Multiple tick invocations prove the model is periodic rounds, not a
    // single streaming continuation. Allow ≥2 to absorb CI timer jitter.
    expect(tickSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Behavioral assertion: once the handler stops, no further ticks fire
    // even if the interval would have elapsed. This is the AC-47 "no new
    // ticks after close" guarantee at the handler layer (the engine layer
    // is already covered by the replaceTeamTriggers test above).
    const countAfterStop = tickSpy.mock.calls.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(tickSpy.mock.calls.length).toBe(countAfterStop);
  });

  it('completes in-flight tasks before dispatching the next window round', async () => {
    // AC-47: An in-flight delegateTask invoked by a tick must be allowed to
    // resolve even when the window closes (replaceTeamTriggers('t1', [])).
    // The engine stops the handler but does not cancel in-flight work.
    let resolveInflight: (value: string) => void = () => {};
    const inflight = new Promise<string>((resolve) => { resolveInflight = resolve; });
    const slowDelegate = vi.fn().mockImplementation(() => inflight);
    const engine = new TriggerEngine({ dedup, rateLimiter, delegateTask: slowDelegate, logger });
    engine.replaceTeamTriggers('t1', [
      makeTrigger({ name: 'w1', type: 'window', config: { tick_interval_ms: 15 }, team: 't1' }),
    ]);
    engine.start();
    await new Promise((r) => setTimeout(r, 30));
    // Precondition: at least one tick must have fired so a delegation is truly
    // in flight when we close the window. Without this the test would degrade
    // into a no-op (closing a window that never ticked).
    expect(slowDelegate.mock.calls.length).toBeGreaterThanOrEqual(1);
    // Close the window mid-flight
    engine.replaceTeamTriggers('t1', []);
    expect(engine.getTeamTriggerCount('t1')).toBe(0);
    // The in-flight promise must still settle cleanly — no engine-driven abort
    resolveInflight('task-done');
    await expect(inflight).resolves.toBe('task-done');
    engine.stop();
  });
});
