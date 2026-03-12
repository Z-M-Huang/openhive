import cron from 'node-cron';
import type { BusEvent, EventBus, TriggerScheduler } from '../domain/index.js';
import { ValidationError } from '../domain/errors.js';

type TriggerType = 'cron' | 'webhook' | 'channel_event' | 'task_completion';

/** Callback invoked when a trigger fires. */
export type TriggerFireHandler = (teamSlug: string, prompt: string) => void;

interface TriggerEntry {
  name: string;
  type: TriggerType;
  teamSlug: string;
  schedule?: string;
  prompt?: string;
  path?: string;
  eventType?: string;
  cronTask?: cron.ScheduledTask;
  subscriptionId?: string;
  active: boolean;
}

/** Pattern for valid webhook paths: alphanumeric + hyphens only. */
const WEBHOOK_PATH_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Manages cron, webhook, channel_event, and task_completion triggers.
 *
 * Requires an EventBus for event-based triggers and a fire handler
 * callback for dispatching tasks when triggers fire.
 */
export class TriggerSchedulerImpl implements TriggerScheduler {
  private readonly triggers = new Map<string, TriggerEntry>();
  private readonly eventBus: EventBus | undefined;
  private readonly onFire: TriggerFireHandler | undefined;
  private started = false;

  constructor(eventBus?: EventBus, onFire?: TriggerFireHandler) {
    this.eventBus = eventBus;
    this.onFire = onFire;
  }

  async loadTriggers(): Promise<void> {
    // Clears existing triggers and reloads from config.
    // In the full system, this reads from ConfigLoader.
    // For now, this resets to an empty state (config loading is wired in L8 orchestrator step).
    this.stopAll();
    this.triggers.clear();
  }

  addCronTrigger(name: string, schedule: string, teamSlug: string, prompt: string): void {
    if (!cron.validate(schedule)) {
      throw new ValidationError(`Invalid cron expression: '${schedule}'`);
    }

    // Replace existing trigger with same name
    this.removeTrigger(name);

    const entry: TriggerEntry = {
      name,
      type: 'cron',
      teamSlug,
      schedule,
      prompt,
      active: false,
    };

    // Create the cron task (not started by default)
    entry.cronTask = cron.schedule(schedule, () => {
      this.fireTrigger(entry);
    }, { scheduled: false });

    this.triggers.set(name, entry);

    // If scheduler is already running, start this trigger immediately
    if (this.started && entry.cronTask) {
      entry.cronTask.start();
      entry.active = true;
    }
  }

  addWebhookTrigger(name: string, path: string, teamSlug: string): void {
    // Validate path: no /api/* shadowing
    if (path.startsWith('api/') || path.startsWith('/api/') || path === 'api') {
      throw new ValidationError(`Webhook path '${path}' would shadow API routes`);
    }

    // Strip leading slash for validation
    const cleanPath = path.startsWith('/') ? path.slice(1) : path;
    if (!WEBHOOK_PATH_PATTERN.test(cleanPath)) {
      throw new ValidationError(
        `Invalid webhook path '${path}'. Must be alphanumeric with hyphens only`
      );
    }

    this.removeTrigger(name);

    const entry: TriggerEntry = {
      name,
      type: 'webhook',
      teamSlug,
      path: cleanPath,
      active: this.started,
    };

    this.triggers.set(name, entry);
  }

  addEventTrigger(
    name: string,
    eventType: string,
    teamSlug: string,
    prompt: string,
    filter?: (event: BusEvent) => boolean,
  ): void {
    this.removeTrigger(name);

    const entry: TriggerEntry = {
      name,
      type: 'channel_event',
      teamSlug,
      eventType,
      prompt,
      active: false,
    };

    // Build combined filter: event type + optional user filter
    const combinedFilter = (event: BusEvent): boolean => {
      if (event.type !== eventType) return false;
      return filter ? filter(event) : true;
    };

    // Subscribe to EventBus if available and started (or defer to start())
    if (this.eventBus && this.started) {
      entry.subscriptionId = this.eventBus.filteredSubscribe(
        combinedFilter,
        () => this.fireTrigger(entry),
      );
      entry.active = true;
    }

    // Store combined filter for deferred subscription in start()
    (entry as TriggerEntry & { _filter?: (event: BusEvent) => boolean })._filter = combinedFilter;

    this.triggers.set(name, entry);
  }

  addTaskCompletionTrigger(
    name: string,
    teamSlug: string,
    prompt: string,
    sourceTeam?: string,
    statusFilter?: string[],
  ): void {
    this.removeTrigger(name);

    const entry: TriggerEntry = {
      name,
      type: 'task_completion',
      teamSlug,
      eventType: 'task.completed',
      prompt,
      active: false,
    };

    const filterFn = (event: BusEvent): boolean => {
      if (event.type !== 'task.completed' && event.type !== 'task.failed') return false;
      if (sourceTeam && event.data['team_slug'] !== sourceTeam) return false;
      if (statusFilter && statusFilter.length > 0) {
        const status = event.data['status'] as string;
        if (!statusFilter.includes(status)) return false;
      }
      return true;
    };

    if (this.eventBus && this.started) {
      entry.subscriptionId = this.eventBus.filteredSubscribe(
        filterFn,
        () => this.fireTrigger(entry),
      );
      entry.active = true;
    }

    (entry as TriggerEntry & { _filter?: (event: BusEvent) => boolean })._filter = filterFn;

    this.triggers.set(name, entry);
  }

  removeTrigger(name: string): void {
    const entry = this.triggers.get(name);
    if (!entry) return;

    if (entry.cronTask) {
      entry.cronTask.stop();
    }
    if (entry.subscriptionId && this.eventBus) {
      this.eventBus.unsubscribe(entry.subscriptionId);
    }
    entry.active = false;
    this.triggers.delete(name);
  }

  listTriggers(): Array<{ name: string; type: string; schedule?: string; teamSlug: string }> {
    const result: Array<{ name: string; type: string; schedule?: string; teamSlug: string }> = [];
    for (const entry of this.triggers.values()) {
      result.push({
        name: entry.name,
        type: entry.type,
        schedule: entry.schedule,
        teamSlug: entry.teamSlug,
      });
    }
    return result;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    for (const entry of this.triggers.values()) {
      this.activateEntry(entry);
    }
  }

  stop(): void {
    if (!this.started) return;
    this.stopAll();
    this.started = false;
  }

  private stopAll(): void {
    for (const entry of this.triggers.values()) {
      if (entry.cronTask) {
        entry.cronTask.stop();
      }
      if (entry.subscriptionId && this.eventBus) {
        this.eventBus.unsubscribe(entry.subscriptionId);
        entry.subscriptionId = undefined;
      }
      entry.active = false;
    }
  }

  private activateEntry(entry: TriggerEntry): void {
    if (entry.active) return;

    switch (entry.type) {
      case 'cron':
        if (entry.cronTask) {
          entry.cronTask.start();
          entry.active = true;
        }
        break;
      case 'webhook':
        entry.active = true;
        break;
      case 'channel_event':
      case 'task_completion':
        if (this.eventBus) {
          const filterFn = (entry as TriggerEntry & { _filter?: (event: BusEvent) => boolean })._filter;
          entry.subscriptionId = this.eventBus.filteredSubscribe(
            filterFn ?? (() => true),
            () => this.fireTrigger(entry),
          );
          entry.active = true;
        }
        break;
    }
  }

  private fireTrigger(entry: TriggerEntry): void {
    if (this.onFire && entry.prompt) {
      this.onFire(entry.teamSlug, entry.prompt);
    }
  }
}
