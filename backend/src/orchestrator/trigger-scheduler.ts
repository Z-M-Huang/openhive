/**
 * OpenHive Backend - TriggerScheduler
 *
 * Manages cron-based trigger scheduling. Polls the TriggerStore at a
 * configurable interval to find due triggers and dispatches tasks through
 * the normal dispatchTask pipeline.
 *
 * Architecture:
 *   - Orchestrator-driven: the scheduler owns the timer, not the triggers.
 *   - Plugs into existing dispatch: triggers create tasks via TaskCoordinator.
 *   - Cron parsing delegated to a simple next-run calculator (no node-cron dep).
 */

import type { Trigger, Event, ChannelMessagePayload, TaskCompletedPayload } from '../domain/types.js';
import type { TriggerStore, TriggerScheduler, TriggerStatus, EventBus, TaskStore } from '../domain/interfaces.js';
import { validateSlug } from '../domain/validation.js';

// ---------------------------------------------------------------------------
// Cron helpers — minimal next-run calculator for standard 5-field cron
// ---------------------------------------------------------------------------

/**
 * Parses a 5-field cron expression and returns the next Date after `after`.
 * Supports: minute (0-59), hour (0-23), day-of-month (1-31), month (1-12),
 * day-of-week (0-7 where 0 and 7 are Sunday).
 *
 * Supports: numbers, ranges (1-5), step values (star/N), comma lists (1,3,5), star.
 * Does NOT support: names (MON, JAN), L, W, hash, or 6/7-field expressions.
 *
 * Returns null if the expression is invalid or no match found within 366 days.
 */
export function nextCronRun(expression: string, after: Date): Date | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const minuteSet = parseField(fields[0]!, 0, 59);
  const hourSet = parseField(fields[1]!, 0, 23);
  const domSet = parseField(fields[2]!, 1, 31);
  const monthSet = parseField(fields[3]!, 1, 12);
  const dowSet = parseField(fields[4]!, 0, 7);

  if (!minuteSet || !hourSet || !domSet || !monthSet || !dowSet) return null;

  // Normalize day-of-week: 7 → 0 (both mean Sunday)
  const normalizedDow = new Set<number>();
  for (const d of dowSet) {
    normalizedDow.add(d === 7 ? 0 : d);
  }

  // Advance one minute past `after` to avoid re-firing on the same minute.
  const candidate = new Date(after.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  // Search up to 366 days ahead (covers leap years).
  const maxTime = after.getTime() + 366 * 24 * 60 * 60 * 1000;

  while (candidate.getTime() <= maxTime) {
    const month = candidate.getMonth() + 1; // JS months are 0-indexed
    if (!monthSet.has(month)) {
      // Skip to first day of next month
      candidate.setMonth(candidate.getMonth() + 1, 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }

    const dom = candidate.getDate();
    const dow = candidate.getDay();
    if (!domSet.has(dom) || !normalizedDow.has(dow)) {
      // Skip to next day
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }

    const hour = candidate.getHours();
    if (!hourSet.has(hour)) {
      // Skip to next hour
      candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
      continue;
    }

    const minute = candidate.getMinutes();
    if (!minuteSet.has(minute)) {
      // Skip to next minute
      candidate.setMinutes(candidate.getMinutes() + 1, 0, 0);
      continue;
    }

    // All fields match
    return new Date(candidate.getTime());
  }

  return null;
}

/**
 * Parses a single cron field into a Set of valid values.
 * Returns null if the field is invalid.
 */
function parseField(field: string, min: number, max: number): Set<number> | null {
  const result = new Set<number>();

  for (const part of field.split(',')) {
    // Handle step values: "star/2" or "1-10/3"
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    if (stepMatch) {
      const step = parseInt(stepMatch[2]!, 10);
      if (step === 0 || isNaN(step)) return null;

      const base = stepMatch[1]!;
      let rangeMin = min;
      let rangeMax = max;

      if (base === '*') {
        // */N — step through full range
      } else {
        const rangeParts = base.split('-');
        if (rangeParts.length === 2) {
          rangeMin = parseInt(rangeParts[0]!, 10);
          rangeMax = parseInt(rangeParts[1]!, 10);
        } else {
          rangeMin = parseInt(base, 10);
          rangeMax = max;
        }
      }

      if (isNaN(rangeMin) || isNaN(rangeMax)) return null;

      for (let i = rangeMin; i <= rangeMax; i += step) {
        if (i >= min && i <= max) result.add(i);
      }
      continue;
    }

    // Handle ranges: "1-5"
    if (part.includes('-')) {
      const rangeParts = part.split('-');
      if (rangeParts.length !== 2) return null;
      const start = parseInt(rangeParts[0]!, 10);
      const end = parseInt(rangeParts[1]!, 10);
      if (isNaN(start) || isNaN(end) || start < min || end > max || start > end) return null;
      for (let i = start; i <= end; i++) {
        result.add(i);
      }
      continue;
    }

    // Handle star: "*"
    if (part === '*') {
      for (let i = min; i <= max; i++) {
        result.add(i);
      }
      continue;
    }

    // Handle single number
    const num = parseInt(part, 10);
    if (isNaN(num) || num < min || num > max) return null;
    result.add(num);
  }

  return result.size > 0 ? result : null;
}

// ---------------------------------------------------------------------------
// TriggerSchedulerDeps
// ---------------------------------------------------------------------------

/**
 * Dependencies injected into the TriggerScheduler.
 */
export interface TriggerSchedulerDeps {
  triggerStore: TriggerStore;
  /** Dispatches a task. Returns the task ID on success. */
  dispatchTask: (teamSlug: string, agentAid: string, prompt: string) => Promise<string>;
  logger: {
    info(msg: string, data?: Record<string, unknown>): void;
    warn(msg: string, data?: Record<string, unknown>): void;
    error(msg: string, data?: Record<string, unknown>): void;
  };
  /** Poll interval in milliseconds. Default: 60_000 (1 minute). */
  pollIntervalMs?: number;
  /** EventBus for channel_event and task_completion triggers. Optional — event triggers are disabled if not provided. */
  eventBus?: EventBus;
  /** TaskStore for looking up task team_slug on task_completion events. Required if eventBus is provided. */
  taskStore?: TaskStore;
}

// ---------------------------------------------------------------------------
// TriggerSchedulerImpl
// ---------------------------------------------------------------------------

export class TriggerSchedulerImpl implements TriggerScheduler {
  private readonly deps: TriggerSchedulerDeps;
  private readonly pollIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** Guards against overlapping poll() calls. */
  private polling = false;
  /** In-memory tracking of active triggers by name. */
  private activeTriggers: Map<string, Trigger> = new Map();
  /** Last skip/status tracking. */
  private lastSkipped: Map<string, Date> = new Map();
  /** EventBus subscription IDs for cleanup on stop(). */
  private eventSubIds: string[] = [];

  constructor(deps: TriggerSchedulerDeps) {
    this.deps = deps;
    this.pollIntervalMs = deps.pollIntervalMs ?? 60_000;
  }

  async start(triggers: Trigger[]): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Index triggers by name
    for (const trigger of triggers) {
      if (trigger.enabled) {
        this.activeTriggers.set(trigger.name, trigger);
      }
    }

    // Compute initial next_run_at for cron triggers only (skip event-driven types)
    const now = new Date();
    for (const trigger of triggers) {
      const triggerType = trigger.type ?? 'cron';
      if (triggerType !== 'cron') continue; // Only cron triggers use schedule-based next_run_at
      if (trigger.enabled && trigger.schedule !== '' && trigger.next_run_at === null) {
        const nextRun = nextCronRun(trigger.schedule, now);
        if (nextRun !== null) {
          const updated = { ...trigger, next_run_at: nextRun, updated_at: now };
          try {
            await this.deps.triggerStore.update(updated);
          } catch (err) {
            this.deps.logger.warn('failed to set initial next_run_at for trigger', {
              name: trigger.name,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }

    // Subscribe to EventBus for event-driven triggers (channel_event, task_completion)
    this.subscribeEventTriggers();

    this.deps.logger.info('trigger scheduler started', {
      trigger_count: triggers.length,
      poll_interval_ms: this.pollIntervalMs,
    });

    // Start polling loop
    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.activeTriggers.clear();
    this.lastSkipped.clear();

    // Unsubscribe from EventBus
    if (this.deps.eventBus !== undefined) {
      for (const subId of this.eventSubIds) {
        this.deps.eventBus.unsubscribe(subId);
      }
    }
    this.eventSubIds = [];

    this.deps.logger.info('trigger scheduler stopped');
  }

  async addTrigger(trigger: Trigger): Promise<void> {
    if (!trigger.enabled) return;

    const triggerType = trigger.type ?? 'cron';

    // Validate webhook_path for webhook triggers
    if (triggerType === 'webhook') {
      const webhookPath = trigger.webhook_path ?? '';
      if (webhookPath === '') {
        throw new Error('webhook triggers require a non-empty webhook_path');
      }
      validateSlug(webhookPath);
    }

    // Validate channel_event triggers
    if (triggerType === 'channel_event') {
      const pattern = trigger.pattern ?? '';
      if (pattern === '') {
        throw new Error('channel_event triggers require a non-empty pattern');
      }
    }

    // Validate task_completion triggers
    if (triggerType === 'task_completion') {
      const sourceTeam = trigger.source_task_team ?? '';
      if (sourceTeam === '') {
        throw new Error('task_completion triggers require a non-empty source_task_team');
      }
    }

    // Compute next_run_at if missing so listDue can pick it up (cron only)
    let toActivate = trigger;
    if (triggerType === 'cron' && trigger.next_run_at === null && trigger.schedule !== '') {
      const nextRun = nextCronRun(trigger.schedule, new Date());
      if (nextRun !== null) {
        toActivate = { ...trigger, next_run_at: nextRun, updated_at: new Date() };
        await this.deps.triggerStore.update(toActivate);
      }
    }

    this.activeTriggers.set(toActivate.name, toActivate);
    this.deps.logger.info('trigger added', { name: toActivate.name });
  }

  async removeTrigger(name: string): Promise<void> {
    this.activeTriggers.delete(name);
    this.lastSkipped.delete(name);
    this.deps.logger.info('trigger removed', { name });
  }

  listActive(): TriggerStatus[] {
    const result: TriggerStatus[] = [];
    for (const trigger of this.activeTriggers.values()) {
      result.push({
        name: trigger.name,
        enabled: trigger.enabled,
        last_run_at: trigger.last_run_at,
        next_run_at: trigger.next_run_at,
      });
    }
    return result;
  }

  getWebhookTrigger(path: string): Trigger | undefined {
    for (const trigger of this.activeTriggers.values()) {
      if ((trigger.type ?? 'cron') === 'webhook' && trigger.webhook_path === path) {
        return trigger;
      }
    }
    return undefined;
  }

  /**
   * Poll for due triggers and dispatch tasks.
   * Called by the interval timer. Exposed for testing.
   */
  async poll(): Promise<void> {
    if (!this.running) return;
    if (this.polling) return;
    this.polling = true;

    try {
      const now = new Date();
      let dueTriggers: Trigger[];

      try {
        dueTriggers = await this.deps.triggerStore.listDue(now);
      } catch (err) {
        this.deps.logger.error('failed to list due triggers', {
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      for (const trigger of dueTriggers) {
        try {
          // Dispatch task
          const taskId = await this.deps.dispatchTask(
            trigger.team_slug,
            trigger.agent_aid,
            trigger.prompt,
          );

          this.deps.logger.info('trigger fired', {
            trigger_name: trigger.name,
            task_id: taskId,
            team_slug: trigger.team_slug,
          });

          // Update trigger: clone to avoid mutating the store's object
          const nextRun = nextCronRun(trigger.schedule, now);
          const updated = {
            ...trigger,
            last_run_at: now,
            next_run_at: nextRun,
            updated_at: now,
          };

          await this.deps.triggerStore.update(updated);

          // Update in-memory tracking with the cloned object
          this.activeTriggers.set(trigger.name, updated);
        } catch (err) {
          this.deps.logger.error('failed to fire trigger', {
            trigger_name: trigger.name,
            error: err instanceof Error ? err.message : String(err),
          });
          this.lastSkipped.set(trigger.name, now);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  // -------------------------------------------------------------------------
  // EventBus subscriptions for channel_event and task_completion triggers
  // -------------------------------------------------------------------------

  /**
   * Subscribes to channel_message and task_completed events on the EventBus.
   * No-op if eventBus is not provided in deps.
   */
  private subscribeEventTriggers(): void {
    const { eventBus } = this.deps;
    if (eventBus === undefined) return;

    // Subscribe to channel_message events for channel_event triggers
    const channelSubId = eventBus.subscribe('channel_message', (event: Event) => {
      void this.handleChannelEvent(event);
    });
    this.eventSubIds.push(channelSubId);

    // Subscribe to task_completed events for task_completion triggers
    const taskSubId = eventBus.subscribe('task_completed', (event: Event) => {
      void this.handleTaskCompletionEvent(event);
    });
    this.eventSubIds.push(taskSubId);
  }

  /**
   * Handles a channel_message event by checking all active channel_event triggers.
   * If the message content matches the trigger's pattern regex, a task is dispatched.
   */
  private async handleChannelEvent(event: Event): Promise<void> {
    const payload = event.payload as ChannelMessagePayload;

    for (const trigger of this.activeTriggers.values()) {
      const triggerType = trigger.type ?? 'cron';
      if (triggerType !== 'channel_event') continue;

      // Filter by channel if specified on the trigger
      const triggerChannel = trigger.channel ?? '';
      if (triggerChannel !== '' && payload.channel !== undefined && payload.channel !== triggerChannel) continue;

      const triggerPattern = trigger.pattern ?? '';
      if (triggerPattern === '') continue;

      try {
        const regex = new RegExp(triggerPattern, 'i');
        if (!regex.test(payload.content)) continue;
      } catch {
        this.deps.logger.warn('invalid channel_event trigger pattern', {
          trigger_name: trigger.name,
          pattern: triggerPattern,
        });
        continue;
      }

      try {
        const taskId = await this.deps.dispatchTask(
          trigger.team_slug,
          trigger.agent_aid,
          trigger.prompt,
        );

        const now = new Date();
        const updated = { ...trigger, last_run_at: now, updated_at: now };
        await this.deps.triggerStore.update(updated);
        this.activeTriggers.set(trigger.name, updated);

        this.deps.logger.info('channel_event trigger fired', {
          trigger_name: trigger.name,
          task_id: taskId,
          jid: payload.jid,
        });
      } catch (err) {
        this.deps.logger.error('failed to fire channel_event trigger', {
          trigger_name: trigger.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Handles a task_completed event by checking all active task_completion triggers.
   * If the completed task belongs to the trigger's source_task_team, a follow-up task is dispatched.
   */
  private async handleTaskCompletionEvent(event: Event): Promise<void> {
    const payload = event.payload as TaskCompletedPayload;
    const { taskStore } = this.deps;

    if (taskStore === undefined) return;

    // Look up the completed task to find its team_slug
    let taskTeamSlug: string;
    try {
      const task = await taskStore.get(payload.task_id);
      taskTeamSlug = task.team_slug;
    } catch {
      this.deps.logger.warn('task_completion trigger: could not look up task', {
        task_id: payload.task_id,
      });
      return;
    }

    for (const trigger of this.activeTriggers.values()) {
      const triggerType = trigger.type ?? 'cron';
      if (triggerType !== 'task_completion') continue;

      const sourceTeam = trigger.source_task_team ?? '';
      if (sourceTeam === '' || sourceTeam !== taskTeamSlug) continue;

      try {
        const taskId = await this.deps.dispatchTask(
          trigger.team_slug,
          trigger.agent_aid,
          trigger.prompt,
        );

        const now = new Date();
        const updated = { ...trigger, last_run_at: now, updated_at: now };
        await this.deps.triggerStore.update(updated);
        this.activeTriggers.set(trigger.name, updated);

        this.deps.logger.info('task_completion trigger fired', {
          trigger_name: trigger.name,
          task_id: taskId,
          source_task_id: payload.task_id,
          source_task_team: taskTeamSlug,
        });
      } catch (err) {
        this.deps.logger.error('failed to fire task_completion trigger', {
          trigger_name: trigger.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function newTriggerScheduler(deps: TriggerSchedulerDeps): TriggerSchedulerImpl {
  return new TriggerSchedulerImpl(deps);
}
