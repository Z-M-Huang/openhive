/**
 * Trigger engine -- registers and manages all trigger handlers.
 *
 * Supports three trigger types: schedule, keyword, and message.
 * Integrates deduplication and rate limiting before dispatching.
 */

import type { TriggerConfig } from '../domain/types.js';
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
  readonly triggers: readonly TriggerConfig[];
  readonly dedup: TriggerDedup;
  readonly rateLimiter: TriggerRateLimiter;
  readonly delegateTask: (team: string, task: string, priority?: string) => Promise<void>;
  readonly logger: TriggerEngineLogger;
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

export class TriggerEngine {
  private readonly scheduleHandlers: ScheduleHandler[] = [];
  private readonly keywordHandlers: KeywordHandler[] = [];
  private readonly messageHandlers: MessageHandler[] = [];

  private readonly opts: TriggerEngineOpts;

  constructor(opts: TriggerEngineOpts) {
    this.opts = opts;
  }

  register(): void {
    for (const trigger of this.opts.triggers) {
      switch (trigger.type) {
        case 'schedule':
          this.registerSchedule(trigger);
          break;
        case 'keyword':
          this.registerKeyword(trigger);
          break;
        case 'message':
          this.registerMessage(trigger);
          break;
      }
    }
  }

  onMessage(text: string, channel?: string): void {
    for (const handler of this.keywordHandlers) {
      if (handler.match(text)) {
        this.dispatch(() => {
          void this.fireTrigger(handler.trigger, `keyword:${handler.trigger.name}:${simpleHash(text)}`);
        });
      }
    }
    for (const handler of this.messageHandlers) {
      if (handler.match(text, channel)) {
        this.dispatch(() => {
          void this.fireTrigger(handler.trigger, `message:${handler.trigger.name}:${simpleHash(text + (channel ?? ''))}`);
        });
      }
    }
  }

  start(): void {
    for (const handler of this.scheduleHandlers) {
      handler.start();
    }
    this.opts.logger.info('Trigger engine started', { schedules: this.scheduleHandlers.length });
  }

  stop(): void {
    for (const handler of this.scheduleHandlers) {
      handler.stop();
    }
    this.opts.logger.info('Trigger engine stopped');
  }

  getRegisteredCount(): number {
    return this.scheduleHandlers.length + this.keywordHandlers.length + this.messageHandlers.length;
  }

  private registerSchedule(trigger: TriggerConfig): void {
    const expression = trigger.config['cron'] as string;
    const handler = new ScheduleHandler(expression, () => {
      this.dispatch(() => {
        void this.fireTrigger(trigger, `schedule:${trigger.name}:${cronSlotKey()}`);
      });
    });
    this.scheduleHandlers.push(handler);
    this.opts.logger.info('Registered schedule trigger', { name: trigger.name, cron: expression });
  }

  private registerKeyword(trigger: TriggerConfig): void {
    const pattern = trigger.config['pattern'] as string;
    const handler = new KeywordHandler(pattern, () => {
      // Fallback for direct callback invocation (e.g., tests calling handler.callback())
      void this.fireTrigger(trigger, `keyword:${trigger.name}:direct`);
    });
    handler.trigger = trigger;
    this.keywordHandlers.push(handler);
    this.opts.logger.info('Registered keyword trigger', { name: trigger.name, pattern });
  }

  private registerMessage(trigger: TriggerConfig): void {
    const pattern = trigger.config['pattern'] as string;
    const channelFilter = trigger.config['channel'] as string | undefined;
    const handler = new MessageHandler(pattern, channelFilter, () => {
      // Fallback for direct callback invocation
      void this.fireTrigger(trigger, `message:${trigger.name}:direct`);
    });
    handler.trigger = trigger;
    this.messageHandlers.push(handler);
    this.opts.logger.info('Registered message trigger', { name: trigger.name, pattern });
  }

  private dispatch(fn: () => void): void {
    fn();
  }

  private async fireTrigger(trigger: TriggerConfig, eventId: string): Promise<void> {
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
    await this.opts.delegateTask(trigger.team, trigger.task);
  }
}
