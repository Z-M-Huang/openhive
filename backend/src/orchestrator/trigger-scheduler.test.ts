/**
 * Tests for TriggerScheduler and cron helpers.
 *
 * Covers:
 *   1. nextCronRun parses standard 5-field cron expressions
 *   2. nextCronRun handles step, range, comma, and star fields
 *   3. nextCronRun returns null for invalid expressions
 *   4. TriggerSchedulerImpl.start initializes active triggers
 *   5. TriggerSchedulerImpl.poll dispatches tasks for due triggers
 *   6. TriggerSchedulerImpl.poll updates last_run_at and next_run_at
 *   7. TriggerSchedulerImpl.poll handles dispatch errors gracefully
 *   8. TriggerSchedulerImpl.addTrigger adds to active set
 *   9. TriggerSchedulerImpl.removeTrigger removes from active set
 *   10. TriggerSchedulerImpl.listActive returns current trigger statuses
 *   11. TriggerSchedulerImpl.stop clears all state
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  nextCronRun,
  TriggerSchedulerImpl,
  type TriggerSchedulerDeps,
} from './trigger-scheduler.js';
import type { Trigger, Task, Event } from '../domain/types.js';
import type { TriggerStore, EventBus, TaskStore } from '../domain/interfaces.js';
import { NotFoundError } from '../domain/errors.js';
import type { EventType } from '../domain/enums.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTrigger(overrides: Partial<Trigger> & { name: string }): Trigger {
  return {
    id: overrides.id ?? `trig-${overrides.name}`,
    name: overrides.name,
    team_slug: overrides.team_slug ?? 'test-team',
    agent_aid: overrides.agent_aid ?? 'aid-agent-001',
    schedule: overrides.schedule ?? '0 * * * *',
    prompt: overrides.prompt ?? 'run check',
    enabled: overrides.enabled ?? true,
    type: overrides.type ?? 'cron',
    webhook_path: overrides.webhook_path ?? '',
    channel: overrides.channel,
    pattern: overrides.pattern,
    source_task_team: overrides.source_task_team,
    last_run_at: overrides.last_run_at ?? null,
    next_run_at: overrides.next_run_at ?? null,
    created_at: overrides.created_at ?? new Date(1_000_000),
    updated_at: overrides.updated_at ?? new Date(1_000_000),
  };
}

/**
 * Minimal EventBus mock that captures subscribers and allows manual event dispatch.
 */
function makeMockEventBus(): EventBus & {
  handlers: Map<string, { eventType: EventType; handler: (event: Event) => void }>;
  emit: (event: Event) => void;
} {
  let nextId = 0;
  const handlers = new Map<string, { eventType: EventType; handler: (event: Event) => void }>();

  return {
    handlers,
    publish(_event: Event): void {
      // Not used in these tests — we use emit() directly
    },
    subscribe(eventType: EventType, handler: (event: Event) => void): string {
      const id = `sub-${nextId++}`;
      handlers.set(id, { eventType, handler });
      return id;
    },
    filteredSubscribe(
      eventType: EventType,
      _filter: (event: Event) => boolean,
      handler: (event: Event) => void,
    ): string {
      return this.subscribe(eventType, handler);
    },
    unsubscribe(id: string): void {
      handlers.delete(id);
    },
    close(): void {
      handlers.clear();
    },
    /** Dispatch an event directly to matching subscribers. */
    emit(event: Event): void {
      for (const { eventType, handler } of handlers.values()) {
        if (eventType === event.type) {
          handler(event);
        }
      }
    },
  };
}

/**
 * Minimal TaskStore mock that returns tasks by ID.
 */
function makeMockTaskStore(tasks: Partial<Task>[] = []): TaskStore {
  const taskMap = new Map<string, Task>();
  for (const t of tasks) {
    const full: Task = {
      id: t.id ?? 'task-unknown',
      team_slug: t.team_slug ?? 'unknown-team',
      status: t.status ?? 'completed',
      prompt: t.prompt ?? 'test',
      blocked_by: t.blocked_by ?? [],
      priority: t.priority ?? 0,
      retry_count: t.retry_count ?? 0,
      max_retries: t.max_retries ?? 0,
      created_at: t.created_at ?? new Date(),
      updated_at: t.updated_at ?? new Date(),
      completed_at: t.completed_at ?? null,
    };
    taskMap.set(full.id, full);
  }
  return {
    create: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockImplementation((id: string) => {
      const task = taskMap.get(id);
      if (!task) return Promise.reject(new NotFoundError('task', id));
      return Promise.resolve(task);
    }),
    update: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    listByTeam: vi.fn().mockResolvedValue([]),
    listByStatus: vi.fn().mockResolvedValue([]),
    listByAgent: vi.fn().mockResolvedValue([]),
    getBlockedBy: vi.fn().mockResolvedValue([]),
    unblockTask: vi.fn().mockResolvedValue(false),
    retryTask: vi.fn().mockResolvedValue(false),
    validateDependencies: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockTriggerStore(triggers: Trigger[] = []): TriggerStore {
  const store = [...triggers];
  return {
    create: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockImplementation((id: string) => {
      const t = store.find((x) => x.id === id);
      if (!t) return Promise.reject(new NotFoundError('trigger', id));
      return Promise.resolve(t);
    }),
    update: vi.fn().mockImplementation((trigger: Trigger) => {
      const idx = store.findIndex((x) => x.id === trigger.id);
      if (idx !== -1) store[idx] = trigger;
      return Promise.resolve();
    }),
    delete: vi.fn().mockResolvedValue(undefined),
    listByTeam: vi.fn().mockResolvedValue([]),
    listEnabled: vi.fn().mockResolvedValue(triggers.filter((t) => t.enabled)),
    listDue: vi.fn().mockResolvedValue([]),
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// nextCronRun
// ---------------------------------------------------------------------------

describe('nextCronRun', () => {
  it('returns next minute matching "0 * * * *" (every hour at :00)', () => {
    const after = new Date('2026-03-08T10:00:00Z');
    const next = nextCronRun('0 * * * *', after);
    expect(next).not.toBeNull();
    expect(next!.getUTCMinutes()).toBe(0);
    expect(next!.getUTCHours()).toBe(11);
  });

  it('returns next run for "30 9 * * *" (daily at 09:30)', () => {
    const after = new Date('2026-03-08T09:30:00Z');
    const next = nextCronRun('30 9 * * *', after);
    expect(next).not.toBeNull();
    // Should be next day since we are at 09:30 already
    expect(next!.getUTCDate()).toBe(9);
    expect(next!.getUTCHours()).toBe(9);
    expect(next!.getUTCMinutes()).toBe(30);
  });

  it('handles step values "*/15 * * * *" (every 15 minutes)', () => {
    const after = new Date('2026-03-08T10:02:00Z');
    const next = nextCronRun('*/15 * * * *', after);
    expect(next).not.toBeNull();
    expect(next!.getUTCMinutes()).toBe(15);
  });

  it('handles range "1-5 * * * *" (minutes 1-5)', () => {
    const after = new Date('2026-03-08T10:05:00Z');
    const next = nextCronRun('1-5 * * * *', after);
    expect(next).not.toBeNull();
    // Should be next hour, minute 1
    expect(next!.getUTCHours()).toBe(11);
    expect(next!.getUTCMinutes()).toBe(1);
  });

  it('handles comma list "0,30 * * * *" (at :00 and :30)', () => {
    const after = new Date('2026-03-08T10:15:00Z');
    const next = nextCronRun('0,30 * * * *', after);
    expect(next).not.toBeNull();
    expect(next!.getUTCMinutes()).toBe(30);
  });

  it('handles day-of-week "0 9 * * 1" (Monday at 09:00)', () => {
    // March 8, 2026 is a Sunday. Next Monday is March 9.
    const after = new Date('2026-03-08T10:00:00Z');
    const next = nextCronRun('0 9 * * 1', after);
    expect(next).not.toBeNull();
    expect(next!.getUTCDay()).toBe(1); // Monday
    expect(next!.getUTCHours()).toBe(9);
  });

  it('treats day-of-week 7 as Sunday (same as 0)', () => {
    // March 8, 2026 is a Sunday
    const after = new Date('2026-03-08T00:00:00Z');
    const next = nextCronRun('0 0 * * 7', after);
    expect(next).not.toBeNull();
    expect(next!.getUTCDay()).toBe(0); // Sunday
  });

  it('handles month field "0 0 1 6 *" (June 1 at midnight)', () => {
    const after = new Date('2026-03-08T10:00:00Z');
    const next = nextCronRun('0 0 1 6 *', after);
    expect(next).not.toBeNull();
    expect(next!.getUTCMonth()).toBe(5); // June (0-indexed)
    expect(next!.getUTCDate()).toBe(1);
  });

  it('returns null for invalid expression (too few fields)', () => {
    expect(nextCronRun('* * *', new Date())).toBeNull();
  });

  it('returns null for invalid expression (bad range)', () => {
    expect(nextCronRun('70 * * * *', new Date())).toBeNull();
  });

  it('returns null for empty expression', () => {
    expect(nextCronRun('', new Date())).toBeNull();
  });

  it('handles range with step "1-30/5 * * * *"', () => {
    const after = new Date('2026-03-08T10:00:00Z');
    const next = nextCronRun('1-30/5 * * * *', after);
    expect(next).not.toBeNull();
    // Expected minutes: 1, 6, 11, 16, 21, 26
    expect(next!.getUTCMinutes()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// TriggerSchedulerImpl
// ---------------------------------------------------------------------------

describe('TriggerSchedulerImpl', () => {
  let triggerStore: TriggerStore;
  let dispatchTask: ReturnType<typeof vi.fn>;
  let logger: ReturnType<typeof makeLogger>;
  let scheduler: TriggerSchedulerImpl;

  beforeEach(() => {
    triggerStore = makeMockTriggerStore();
    dispatchTask = vi.fn().mockResolvedValue('task-123');
    logger = makeLogger();

    const deps: TriggerSchedulerDeps = {
      triggerStore,
      dispatchTask,
      logger,
      pollIntervalMs: 100_000, // long interval to prevent auto-firing in tests
    };
    scheduler = new TriggerSchedulerImpl(deps);
  });

  it('start() initializes active triggers and computes next_run_at', async () => {
    const trigger = makeTrigger({ name: 'test', schedule: '0 * * * *' });
    await scheduler.start([trigger]);

    const active = scheduler.listActive();
    expect(active).toHaveLength(1);
    expect(active[0]!.name).toBe('test');

    // next_run_at should have been computed
    expect(triggerStore.update).toHaveBeenCalled();

    await scheduler.stop();
  });

  it('start() skips disabled triggers', async () => {
    const trigger = makeTrigger({ name: 'disabled', enabled: false });
    await scheduler.start([trigger]);

    const active = scheduler.listActive();
    expect(active).toHaveLength(0);

    await scheduler.stop();
  });

  it('poll() dispatches tasks for due triggers', async () => {
    const dueTrigger = makeTrigger({
      name: 'due-trigger',
      schedule: '0 * * * *',
      next_run_at: new Date(Date.now() - 60_000),
    });
    (triggerStore.listDue as ReturnType<typeof vi.fn>).mockResolvedValue([dueTrigger]);

    await scheduler.start([dueTrigger]);
    await scheduler.poll();

    expect(dispatchTask).toHaveBeenCalledWith(
      'test-team',
      'aid-agent-001',
      'run check',
    );

    await scheduler.stop();
  });

  it('poll() updates last_run_at and next_run_at after firing', async () => {
    const dueTrigger = makeTrigger({
      name: 'update-trigger',
      schedule: '0 * * * *',
      next_run_at: new Date(Date.now() - 60_000),
    });
    (triggerStore.listDue as ReturnType<typeof vi.fn>).mockResolvedValue([dueTrigger]);

    await scheduler.start([dueTrigger]);
    await scheduler.poll();

    // update should have been called with the trigger having a new last_run_at
    const updateCalls = (triggerStore.update as ReturnType<typeof vi.fn>).mock.calls;
    // Last call should be from poll (not from start's initial next_run_at computation)
    const lastCall = updateCalls[updateCalls.length - 1] as [Trigger];
    expect(lastCall[0].last_run_at).not.toBeNull();
    expect(lastCall[0].next_run_at).not.toBeNull();

    await scheduler.stop();
  });

  it('poll() handles dispatch errors gracefully', async () => {
    const dueTrigger = makeTrigger({
      name: 'error-trigger',
      schedule: '0 * * * *',
      next_run_at: new Date(Date.now() - 60_000),
    });
    (triggerStore.listDue as ReturnType<typeof vi.fn>).mockResolvedValue([dueTrigger]);
    dispatchTask.mockRejectedValue(new Error('dispatch failed'));

    await scheduler.start([dueTrigger]);
    await scheduler.poll();

    expect(logger.error).toHaveBeenCalledWith(
      'failed to fire trigger',
      expect.objectContaining({ trigger_name: 'error-trigger' }),
    );

    await scheduler.stop();
  });

  it('poll() handles listDue errors gracefully', async () => {
    (triggerStore.listDue as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db error'));

    await scheduler.start([]);
    await scheduler.poll();

    expect(logger.error).toHaveBeenCalledWith(
      'failed to list due triggers',
      expect.objectContaining({ error: 'db error' }),
    );

    await scheduler.stop();
  });

  it('addTrigger adds to active set', async () => {
    await scheduler.start([]);
    expect(scheduler.listActive()).toHaveLength(0);

    const trigger = makeTrigger({ name: 'new-trigger' });
    await scheduler.addTrigger(trigger);

    const active = scheduler.listActive();
    expect(active).toHaveLength(1);
    expect(active[0]!.name).toBe('new-trigger');

    await scheduler.stop();
  });

  it('addTrigger does not add disabled triggers', async () => {
    await scheduler.start([]);
    const trigger = makeTrigger({ name: 'disabled', enabled: false });
    await scheduler.addTrigger(trigger);

    expect(scheduler.listActive()).toHaveLength(0);

    await scheduler.stop();
  });

  it('removeTrigger removes from active set', async () => {
    const trigger = makeTrigger({ name: 'removable' });
    await scheduler.start([trigger]);
    expect(scheduler.listActive()).toHaveLength(1);

    await scheduler.removeTrigger('removable');
    expect(scheduler.listActive()).toHaveLength(0);

    await scheduler.stop();
  });

  it('stop() clears all state and prevents further polling', async () => {
    const trigger = makeTrigger({ name: 'stoppable' });
    await scheduler.start([trigger]);
    await scheduler.stop();

    expect(scheduler.listActive()).toHaveLength(0);

    // poll should be a no-op after stop
    await scheduler.poll();
    expect(dispatchTask).not.toHaveBeenCalled();
  });

  it('listActive returns current trigger statuses', async () => {
    const t1 = makeTrigger({ name: 'a', last_run_at: new Date(1000), next_run_at: new Date(2000) });
    const t2 = makeTrigger({ name: 'b' });
    await scheduler.start([t1, t2]);

    const active = scheduler.listActive();
    expect(active).toHaveLength(2);

    const names = active.map((s) => s.name);
    expect(names).toContain('a');
    expect(names).toContain('b');

    await scheduler.stop();
  });

  it('start() is idempotent when called twice', async () => {
    const trigger = makeTrigger({ name: 'idem' });
    await scheduler.start([trigger]);
    await scheduler.start([trigger]); // second call is no-op

    expect(scheduler.listActive()).toHaveLength(1);

    await scheduler.stop();
  });

  // -----------------------------------------------------------------------
  // Webhook trigger tests
  // -----------------------------------------------------------------------

  it('start() skips cron scheduling for webhook triggers', async () => {
    const webhookTrigger = makeTrigger({
      name: 'webhook-trigger',
      type: 'webhook',
      webhook_path: 'deploy',
      schedule: '',
    });
    await scheduler.start([webhookTrigger]);

    // Should be added to activeTriggers (it's enabled)
    const active = scheduler.listActive();
    expect(active).toHaveLength(1);
    expect(active[0]!.name).toBe('webhook-trigger');

    // triggerStore.update should NOT be called for webhook triggers (no next_run_at computation)
    expect(triggerStore.update).not.toHaveBeenCalled();

    await scheduler.stop();
  });

  it('addTrigger skips cron scheduling for webhook triggers', async () => {
    await scheduler.start([]);
    const webhookTrigger = makeTrigger({
      name: 'added-webhook',
      type: 'webhook',
      webhook_path: 'my-hook',
      schedule: '',
    });
    await scheduler.addTrigger(webhookTrigger);

    expect(scheduler.listActive()).toHaveLength(1);
    // Should not compute next_run_at for webhooks
    expect(triggerStore.update).not.toHaveBeenCalled();

    await scheduler.stop();
  });

  it('addTrigger validates webhook_path with validateSlug', async () => {
    await scheduler.start([]);
    const webhookTrigger = makeTrigger({
      name: 'bad-path',
      type: 'webhook',
      webhook_path: 'INVALID SLUG!!',
      schedule: '',
    });

    await expect(scheduler.addTrigger(webhookTrigger)).rejects.toThrow();

    await scheduler.stop();
  });

  it('addTrigger rejects webhook trigger with empty webhook_path', async () => {
    await scheduler.start([]);
    const webhookTrigger = makeTrigger({
      name: 'no-path',
      type: 'webhook',
      webhook_path: '',
      schedule: '',
    });

    await expect(scheduler.addTrigger(webhookTrigger)).rejects.toThrow('webhook triggers require a non-empty webhook_path');

    await scheduler.stop();
  });

  it('getWebhookTrigger returns matching active webhook trigger', async () => {
    const webhookTrigger = makeTrigger({
      name: 'deploy-hook',
      type: 'webhook',
      webhook_path: 'deploy',
      schedule: '',
      prompt: 'run deployment',
    });
    await scheduler.start([webhookTrigger]);

    const result = scheduler.getWebhookTrigger('deploy');
    expect(result).toBeDefined();
    expect(result!.name).toBe('deploy-hook');
    expect(result!.prompt).toBe('run deployment');

    await scheduler.stop();
  });

  it('getWebhookTrigger returns undefined for unknown path', async () => {
    await scheduler.start([]);
    const result = scheduler.getWebhookTrigger('nonexistent');
    expect(result).toBeUndefined();

    await scheduler.stop();
  });

  it('getWebhookTrigger returns undefined for cron triggers', async () => {
    const cronTrigger = makeTrigger({ name: 'cron-only', type: 'cron' });
    await scheduler.start([cronTrigger]);

    const result = scheduler.getWebhookTrigger('cron-only');
    expect(result).toBeUndefined();

    await scheduler.stop();
  });

  it('getWebhookTrigger does not find disabled triggers (not in activeTriggers)', async () => {
    const disabledWebhook = makeTrigger({
      name: 'disabled-webhook',
      type: 'webhook',
      webhook_path: 'disabled-path',
      enabled: false,
    });
    await scheduler.start([disabledWebhook]);

    const result = scheduler.getWebhookTrigger('disabled-path');
    expect(result).toBeUndefined();

    await scheduler.stop();
  });

  // -----------------------------------------------------------------------
  // channel_event trigger tests
  // -----------------------------------------------------------------------

  it('start() skips cron scheduling for channel_event triggers', async () => {
    const channelTrigger = makeTrigger({
      name: 'channel-trigger',
      type: 'channel_event',
      pattern: 'help|support',
      schedule: '',
    });
    await scheduler.start([channelTrigger]);

    const active = scheduler.listActive();
    expect(active).toHaveLength(1);
    // No next_run_at computation for event-driven triggers
    expect(triggerStore.update).not.toHaveBeenCalled();

    await scheduler.stop();
  });

  it('addTrigger rejects channel_event trigger with empty pattern', async () => {
    await scheduler.start([]);
    const trigger = makeTrigger({
      name: 'no-pattern',
      type: 'channel_event',
      pattern: '',
      schedule: '',
    });

    await expect(scheduler.addTrigger(trigger)).rejects.toThrow('channel_event triggers require a non-empty pattern');

    await scheduler.stop();
  });

  it('start() skips cron scheduling for task_completion triggers', async () => {
    const completionTrigger = makeTrigger({
      name: 'completion-trigger',
      type: 'task_completion',
      source_task_team: 'build-team',
      schedule: '',
    });
    await scheduler.start([completionTrigger]);

    const active = scheduler.listActive();
    expect(active).toHaveLength(1);
    expect(triggerStore.update).not.toHaveBeenCalled();

    await scheduler.stop();
  });

  it('addTrigger rejects task_completion trigger with empty source_task_team', async () => {
    await scheduler.start([]);
    const trigger = makeTrigger({
      name: 'no-source',
      type: 'task_completion',
      source_task_team: '',
      schedule: '',
    });

    await expect(scheduler.addTrigger(trigger)).rejects.toThrow('task_completion triggers require a non-empty source_task_team');

    await scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// Event-driven triggers (channel_event + task_completion via EventBus)
// ---------------------------------------------------------------------------

describe('event-driven triggers', () => {
  let triggerStore: TriggerStore;
  let dispatchTask: ReturnType<typeof vi.fn>;
  let logger: ReturnType<typeof makeLogger>;
  let eventBus: ReturnType<typeof makeMockEventBus>;
  let taskStore: TaskStore;

  beforeEach(() => {
    triggerStore = makeMockTriggerStore();
    dispatchTask = vi.fn().mockResolvedValue('task-fired-123');
    logger = makeLogger();
    eventBus = makeMockEventBus();
    taskStore = makeMockTaskStore([
      { id: 'task-src-1', team_slug: 'build-team' },
      { id: 'task-src-2', team_slug: 'other-team' },
    ]);
  });

  function makeEventScheduler(): TriggerSchedulerImpl {
    return new TriggerSchedulerImpl({
      triggerStore,
      dispatchTask,
      logger,
      pollIntervalMs: 100_000,
      eventBus,
      taskStore,
    });
  }

  // channel_event tests

  it('fires channel_event trigger when message matches pattern', async () => {
    const scheduler = makeEventScheduler();
    const trigger = makeTrigger({
      name: 'support-triage',
      type: 'channel_event',
      pattern: 'help|support',
      schedule: '',
      prompt: 'triage this request',
    });
    await scheduler.start([trigger]);

    // Emit a channel_message event with matching content
    const event: Event = {
      type: 'channel_message',
      payload: { kind: 'channel_message', jid: 'jid-001', content: 'I need help with my account' },
    };
    eventBus.emit(event);

    // Wait for async handler
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(dispatchTask).toHaveBeenCalledWith('test-team', 'aid-agent-001', 'triage this request');
    expect(logger.info).toHaveBeenCalledWith('channel_event trigger fired', expect.objectContaining({
      trigger_name: 'support-triage',
    }));

    await scheduler.stop();
  });

  it('does not fire channel_event trigger when message does not match pattern', async () => {
    const scheduler = makeEventScheduler();
    const trigger = makeTrigger({
      name: 'support-triage',
      type: 'channel_event',
      pattern: 'help|support',
      schedule: '',
    });
    await scheduler.start([trigger]);

    const event: Event = {
      type: 'channel_message',
      payload: { kind: 'channel_message', jid: 'jid-001', content: 'hello there, nice weather' },
    };
    eventBus.emit(event);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(dispatchTask).not.toHaveBeenCalled();

    await scheduler.stop();
  });

  it('logs warning for invalid regex pattern in channel_event trigger', async () => {
    const scheduler = makeEventScheduler();
    const trigger = makeTrigger({
      name: 'bad-regex',
      type: 'channel_event',
      pattern: '[invalid',
      schedule: '',
    });
    // Directly add to active triggers (bypass addTrigger validation for this test)
    await scheduler.start([trigger]);

    const event: Event = {
      type: 'channel_message',
      payload: { kind: 'channel_message', jid: 'jid-001', content: 'test message' },
    };
    eventBus.emit(event);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(logger.warn).toHaveBeenCalledWith('invalid channel_event trigger pattern', expect.objectContaining({
      trigger_name: 'bad-regex',
    }));
    expect(dispatchTask).not.toHaveBeenCalled();

    await scheduler.stop();
  });

  // task_completion tests

  it('fires task_completion trigger when task in source team completes', async () => {
    const scheduler = makeEventScheduler();
    const trigger = makeTrigger({
      name: 'deploy-after-build',
      type: 'task_completion',
      source_task_team: 'build-team',
      schedule: '',
      prompt: 'deploy the build',
    });
    await scheduler.start([trigger]);

    const event: Event = {
      type: 'task_completed',
      payload: {
        kind: 'task_completed',
        task_id: 'task-src-1',
        result: { task_id: 'task-src-1', status: 'completed', duration: 1000 },
      },
    };
    eventBus.emit(event);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(dispatchTask).toHaveBeenCalledWith('test-team', 'aid-agent-001', 'deploy the build');
    expect(logger.info).toHaveBeenCalledWith('task_completion trigger fired', expect.objectContaining({
      trigger_name: 'deploy-after-build',
      source_task_team: 'build-team',
    }));

    await scheduler.stop();
  });

  it('does not fire task_completion trigger for task in different team', async () => {
    const scheduler = makeEventScheduler();
    const trigger = makeTrigger({
      name: 'deploy-after-build',
      type: 'task_completion',
      source_task_team: 'build-team',
      schedule: '',
    });
    await scheduler.start([trigger]);

    const event: Event = {
      type: 'task_completed',
      payload: {
        kind: 'task_completed',
        task_id: 'task-src-2',  // other-team, not build-team
        result: { task_id: 'task-src-2', status: 'completed', duration: 500 },
      },
    };
    eventBus.emit(event);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(dispatchTask).not.toHaveBeenCalled();

    await scheduler.stop();
  });

  it('handles unknown task in task_completion gracefully', async () => {
    const scheduler = makeEventScheduler();
    const trigger = makeTrigger({
      name: 'deploy-after-build',
      type: 'task_completion',
      source_task_team: 'build-team',
      schedule: '',
    });
    await scheduler.start([trigger]);

    const event: Event = {
      type: 'task_completed',
      payload: {
        kind: 'task_completed',
        task_id: 'task-unknown-999',  // not in taskStore
        result: { task_id: 'task-unknown-999', status: 'completed', duration: 100 },
      },
    };
    eventBus.emit(event);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(dispatchTask).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('task_completion trigger: could not look up task', expect.objectContaining({
      task_id: 'task-unknown-999',
    }));

    await scheduler.stop();
  });

  // EventBus lifecycle

  it('subscribes to EventBus on start and unsubscribes on stop', async () => {
    const scheduler = makeEventScheduler();
    await scheduler.start([]);

    // Should have 2 subscriptions (channel_message + task_completed)
    expect(eventBus.handlers.size).toBe(2);

    await scheduler.stop();

    // All subscriptions should be removed
    expect(eventBus.handlers.size).toBe(0);
  });

  it('works without eventBus (no subscriptions)', async () => {
    // Scheduler without eventBus — event triggers are simply not active
    const scheduler = new TriggerSchedulerImpl({
      triggerStore,
      dispatchTask,
      logger,
      pollIntervalMs: 100_000,
    });

    const trigger = makeTrigger({
      name: 'channel-trigger',
      type: 'channel_event',
      pattern: 'help',
      schedule: '',
    });
    await scheduler.start([trigger]);

    // Trigger is in active list but no event subscriptions
    expect(scheduler.listActive()).toHaveLength(1);

    await scheduler.stop();
  });
});
