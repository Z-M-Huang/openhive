/**
 * Trigger engine -- registers and manages all trigger handlers.
 *
 * Supports three trigger types: schedule, keyword, and message.
 * Integrates deduplication, rate limiting, state checks, and circuit breaker.
 * Uses a per-team keyed registry for dynamic add/replace/remove.
 */

import type { TriggerConfig } from '../domain/types.js';
import type { ITriggerConfigStore } from '../domain/interfaces.js';
import { ScheduleHandler } from './handlers/schedule.js';
import { KeywordHandler } from './handlers/keyword.js';
import { MessageHandler } from './handlers/message.js';
import type { TriggerDedup } from './dedup.js';
import type { TriggerRateLimiter } from './rate-limiter.js';

export interface TriggerEngineLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface TriggerEngineOpts {
  readonly triggers?: readonly TriggerConfig[];
  readonly dedup: TriggerDedup;
  readonly rateLimiter: TriggerRateLimiter;
  readonly delegateTask: (team: string, task: string, priority?: string, triggerName?: string) => Promise<void>;
  readonly logger: TriggerEngineLogger;
  readonly configStore?: ITriggerConfigStore;
  readonly onTriggerDeactivated?: (team: string, triggerName: string, reason: string) => void;
}

/** Simple string hash for deterministic dedup keys. */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash + ch) | 0;
  }
  return (hash >>> 0).toString(36);
}

/** Current minute timestamp (floored to 60s) for schedule dedup slots. */
function cronSlotKey(): string {
  return String(Math.floor(Date.now() / 60_000));
}

interface TeamHandlerSet {
  schedule: ScheduleHandler[];
  keyword: KeywordHandler[];
  message: MessageHandler[];
}

export class TriggerEngine {
  private readonly teamHandlers = new Map<string, TeamHandlerSet>();
  private running = false;

  private readonly opts: TriggerEngineOpts;

  constructor(opts: TriggerEngineOpts) {
    this.opts = opts;
  }

  /** Register triggers from opts.triggers (grouped by team). Backward-compatible entry point. */
  register(): void {
    const triggers = this.opts.triggers ?? [];
    const byTeam = new Map<string, TriggerConfig[]>();
    for (const t of triggers) {
      const arr = byTeam.get(t.team) ?? [];
      arr.push(t);
      byTeam.set(t.team, arr);
    }
    for (const [team, teamTriggers] of byTeam) {
      this.replaceTeamTriggers(team, teamTriggers);
    }
  }

  /** Load and register all active triggers from the config store. */
  loadFromStore(): void {
    if (!this.opts.configStore) return;
    const all = this.opts.configStore.getAll();
    const active = all.filter(t => t.state === 'active');
    const byTeam = new Map<string, TriggerConfig[]>();
    for (const t of active) {
      const arr = byTeam.get(t.team) ?? [];
      arr.push(t);
      byTeam.set(t.team, arr);
    }
    for (const [team, teamTriggers] of byTeam) {
      this.replaceTeamTriggers(team, teamTriggers);
    }
    this.opts.logger.info('Loaded triggers from store', {
      total: all.length,
      active: active.length,
    });
  }

  onMessage(text: string, channel?: string): void {
    for (const set of this.teamHandlers.values()) {
      for (const handler of set.keyword) {
        if (handler.match(text)) {
          this.dispatch(() => {
            void this.fireTrigger(handler.trigger, `keyword:${handler.trigger.name}:${simpleHash(text)}`);
          });
        }
      }
      for (const handler of set.message) {
        if (handler.match(text, channel)) {
          this.dispatch(() => {
            void this.fireTrigger(handler.trigger, `message:${handler.trigger.name}:${simpleHash(text + (channel ?? ''))}`);
          });
        }
      }
    }
  }

  start(): void {
    this.running = true;
    let scheduleCount = 0;
    for (const set of this.teamHandlers.values()) {
      for (const h of set.schedule) { h.start(); scheduleCount++; }
    }
    this.opts.logger.info('Trigger engine started', { schedules: scheduleCount });
  }

  stop(): void {
    this.running = false;
    for (const set of this.teamHandlers.values()) {
      for (const h of set.schedule) h.stop();
    }
    this.opts.logger.info('Trigger engine stopped');
  }

  getRegisteredCount(): number {
    let count = 0;
    for (const set of this.teamHandlers.values()) {
      count += set.schedule.length + set.keyword.length + set.message.length;
    }
    return count;
  }

  /** Atomically replace all triggers for a team. */
  replaceTeamTriggers(team: string, triggers: TriggerConfig[]): void {
    this.removeTeamTriggers(team);
    const set: TeamHandlerSet = { schedule: [], keyword: [], message: [] };
    for (const trigger of triggers) {
      switch (trigger.type) {
        case 'schedule':
          this.registerScheduleInto(set, trigger);
          break;
        case 'keyword':
          this.registerKeywordInto(set, trigger);
          break;
        case 'message':
          this.registerMessageInto(set, trigger);
          break;
      }
    }
    this.teamHandlers.set(team, set);
    if (this.running) {
      for (const h of set.schedule) h.start();
    }
  }

  /** Remove all triggers for a team. Stops schedule handlers. */
  removeTeamTriggers(team: string): void {
    const existing = this.teamHandlers.get(team);
    if (!existing) return;
    for (const h of existing.schedule) h.stop();
    this.teamHandlers.delete(team);
  }

  /** Count triggers for a specific team. */
  getTeamTriggerCount(team: string): number {
    const set = this.teamHandlers.get(team);
    if (!set) return 0;
    return set.schedule.length + set.keyword.length + set.message.length;
  }

  /** Report a task outcome for circuit breaker accounting. */
  reportTaskOutcome(team: string, triggerName: string, success: boolean): void {
    if (!this.opts.configStore) return;

    if (success) {
      this.opts.configStore.resetFailures(team, triggerName);
      return;
    }

    const count = this.opts.configStore.incrementFailures(team, triggerName);
    const entry = this.opts.configStore.get(team, triggerName);
    const threshold = entry?.failureThreshold ?? 3;

    if (count >= threshold) {
      const reason = `${count} consecutive failures`;
      this.opts.configStore.setState(team, triggerName, 'disabled', reason);
      this.removeTeamTriggers(team);
      // Re-register remaining active triggers for this team
      const remaining = this.opts.configStore.getByTeam(team).filter(t => t.state === 'active');
      if (remaining.length > 0) this.replaceTeamTriggers(team, remaining);
      this.opts.logger.warn('Circuit breaker tripped', { team, trigger: triggerName, failures: count });
      this.opts.onTriggerDeactivated?.(team, triggerName, reason);
    }
  }

  private registerScheduleInto(set: TeamHandlerSet, trigger: TriggerConfig): void {
    const expression = trigger.config['cron'] as string;
    const handler = new ScheduleHandler(expression, () => {
      this.dispatch(() => {
        void this.fireTrigger(trigger, `schedule:${trigger.name}:${cronSlotKey()}`);
      });
    });
    set.schedule.push(handler);
    this.opts.logger.info('Registered schedule trigger', { name: trigger.name, cron: expression });
  }

  private registerKeywordInto(set: TeamHandlerSet, trigger: TriggerConfig): void {
    const pattern = trigger.config['pattern'] as string;
    const handler = new KeywordHandler(pattern, () => {
      void this.fireTrigger(trigger, `keyword:${trigger.name}:direct`);
    });
    handler.trigger = trigger;
    set.keyword.push(handler);
    this.opts.logger.info('Registered keyword trigger', { name: trigger.name, pattern });
  }

  private registerMessageInto(set: TeamHandlerSet, trigger: TriggerConfig): void {
    const pattern = trigger.config['pattern'] as string;
    const channelFilter = trigger.config['channel'] as string | undefined;
    const handler = new MessageHandler(pattern, channelFilter, () => {
      void this.fireTrigger(trigger, `message:${trigger.name}:direct`);
    });
    handler.trigger = trigger;
    set.message.push(handler);
    this.opts.logger.info('Registered message trigger', { name: trigger.name, pattern });
  }

  private dispatch(fn: () => void): void {
    fn();
  }

  private async fireTrigger(trigger: TriggerConfig, eventId: string): Promise<void> {
    // Check state from config store (cheapest guard)
    if (this.opts.configStore) {
      const entry = this.opts.configStore.get(trigger.team, trigger.name);
      if (!entry || entry.state !== 'active') {
        this.opts.logger.info('Trigger skipped (not active)', {
          name: trigger.name, state: entry?.state ?? 'unknown',
        });
        return;
      }
    }

    const source = trigger.team;

    if (this.opts.dedup.check(eventId, source)) {
      this.opts.logger.info('Trigger dedup: skipping duplicate', { name: trigger.name });
      return;
    }

    const rateResult = this.opts.rateLimiter.check(source);
    if (!rateResult.allowed) {
      this.opts.logger.warn('Trigger rate limited', { name: trigger.name, retryAfterMs: rateResult.retryAfterMs });
      return;
    }

    this.opts.dedup.record(eventId, source);
    await this.opts.delegateTask(trigger.team, trigger.task, undefined, trigger.name);
  }
}
