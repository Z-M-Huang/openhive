/** Trigger engine — registers and manages schedule/keyword/message trigger handlers. */

import type { TaskOptions, TriggerConfig } from '../domain/types.js';
import { TaskStatus } from '../domain/types.js';
import type { ITaskQueueStore, ITriggerConfigStore } from '../domain/interfaces.js';
import { ScheduleHandler } from './handlers/schedule.js';
import { KeywordHandler } from './handlers/keyword.js';
import { MessageHandler } from './handlers/message.js';
import type { TriggerDedup } from './dedup.js';
import type { TriggerRateLimiter } from './rate-limiter.js';
import { simpleHash, cronSlotKey, subagentScope } from './engine-helpers.js';
import { checkOverlapPolicy as evalOverlapPolicy } from './overlap-policy.js';

export interface TriggerEngineLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface TriggerEngineOpts {
  readonly triggers?: readonly TriggerConfig[];
  readonly dedup: TriggerDedup;
  readonly rateLimiter: TriggerRateLimiter;
  /**
   * Enqueue a task for the target team. `options` carries the subagent
   * assignment and any maxSteps/skill overrides captured from the trigger
   * config so downstream consumers route to the correct subagent.
   */
  readonly delegateTask: (
    team: string,
    task: string,
    priority?: string,
    triggerName?: string,
    sourceChannelId?: string,
    options?: TaskOptions,
  ) => Promise<string>;
  readonly logger: TriggerEngineLogger;
  readonly configStore?: ITriggerConfigStore;
  readonly taskQueueStore?: ITaskQueueStore;
  readonly abortSession?: (teamId: string, taskId: string) => void;
  readonly onTriggerDeactivated?: (team: string, triggerName: string, reason: string) => void;
  readonly onOverlapAlert?: (team: string, triggerName: string, action: 'skipped' | 'replaced', details: { oldTaskId: string }) => void;
}

interface TeamHandlerSet { schedule: ScheduleHandler[]; keyword: KeywordHandler[]; message: MessageHandler[] }

export class TriggerEngine {
  private readonly teamHandlers = new Map<string, TeamHandlerSet>();
  private running = false;
  private readonly opts: TriggerEngineOpts;

  constructor(opts: TriggerEngineOpts) { this.opts = opts; }

  register(): void { this.registerByTeam(this.opts.triggers ?? []); }

  loadFromStore(): void {
    if (!this.opts.configStore) return;
    const all = this.opts.configStore.getAll();
    const active = all.filter(t => t.state === 'active');
    this.registerByTeam(active);
    this.opts.logger.info('Loaded triggers from store', { total: all.length, active: active.length });
  }

  onMessage(text: string, channel?: string): void {
    for (const set of this.teamHandlers.values()) {
      for (const handler of set.keyword) {
        if (handler.match(text)) {
          this.dispatch(() => {
            void this.fireTrigger(
              handler.trigger,
              `keyword:${handler.trigger.name}:${subagentScope(handler.trigger)}:${simpleHash(text)}`,
              channel,
            );
          });
        }
      }
      for (const handler of set.message) {
        if (handler.match(text, channel)) {
          this.dispatch(() => {
            void this.fireTrigger(
              handler.trigger,
              `message:${handler.trigger.name}:${subagentScope(handler.trigger)}:${simpleHash(text + (channel ?? ''))}`,
              channel,
            );
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
  reportTaskOutcome(team: string, triggerName: string, success: boolean, taskId?: string): void {
    if (!this.opts.configStore) return;

    // Stale outcome guard — ignore results from cancelled tasks
    if (taskId && this.opts.taskQueueStore) {
      const task = this.opts.taskQueueStore.getById(taskId);
      if (task?.status === TaskStatus.Cancelled) {
        return;
      }
    }

    if (success) {
      this.opts.configStore.resetFailures(team, triggerName);
    } else {
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

    // Clear overlap tracking if this task is the active one
    const config = this.opts.configStore.get(team, triggerName);
    if (config?.activeTaskId === taskId) {
      this.opts.configStore.clearActiveTask(team, triggerName);
    }
  }

  private registerScheduleInto(set: TeamHandlerSet, trigger: TriggerConfig): void {
    const expression = trigger.config['cron'] as string;
    const timezone = trigger.config['timezone'] as string | undefined;
    const handler = new ScheduleHandler(expression, () => {
      this.dispatch(() => {
        void this.fireTrigger(
          trigger,
          `schedule:${trigger.name}:${subagentScope(trigger)}:${cronSlotKey()}`,
          trigger.sourceChannelId,
        );
      });
    }, timezone);
    set.schedule.push(handler);
    this.opts.logger.info('Registered schedule trigger', { name: trigger.name, cron: expression, subagent: trigger.subagent });
  }

  private registerKeywordInto(set: TeamHandlerSet, trigger: TriggerConfig): void {
    const pattern = trigger.config['pattern'] as string;
    const handler = new KeywordHandler(pattern, () => {
      void this.fireTrigger(trigger, `keyword:${trigger.name}:${subagentScope(trigger)}:direct`);
    });
    handler.trigger = trigger;
    set.keyword.push(handler);
    this.opts.logger.info('Registered keyword trigger', { name: trigger.name, pattern, subagent: trigger.subagent });
  }

  private registerMessageInto(set: TeamHandlerSet, trigger: TriggerConfig): void {
    const pattern = trigger.config['pattern'] as string;
    const channelFilter = trigger.config['channel'] as string | undefined;
    const handler = new MessageHandler(pattern, channelFilter, () => {
      void this.fireTrigger(trigger, `message:${trigger.name}:${subagentScope(trigger)}:direct`);
    });
    handler.trigger = trigger;
    set.message.push(handler);
    this.opts.logger.info('Registered message trigger', { name: trigger.name, pattern, subagent: trigger.subagent });
  }

  private registerByTeam(triggers: readonly TriggerConfig[]): void {
    const byTeam = new Map<string, TriggerConfig[]>();
    for (const t of triggers) {
      const arr = byTeam.get(t.team) ?? [];
      arr.push(t);
      byTeam.set(t.team, arr);
    }
    for (const [team, teamTriggers] of byTeam) this.replaceTeamTriggers(team, teamTriggers);
  }

  private dispatch(fn: () => void): void { fn(); }

  private async fireTrigger(trigger: TriggerConfig, eventId: string, sourceChannelId?: string): Promise<void> {
    // Read latest config first so we dedup/rate-limit against the live
    // subagent assignment (a trigger edited to swap subagents must not be
    // masked by a dedup scope that still points at the old subagent).
    const liveConfig = this.opts.configStore?.get(trigger.team, trigger.name);
    if (this.opts.configStore) {
      if (!liveConfig || liveConfig.state !== 'active') {
        this.opts.logger.info('Trigger skipped (not active)', { name: trigger.name, state: liveConfig?.state ?? 'unknown' });
        return;
      }
    }

    const effective = liveConfig ?? trigger;
    // Dedup + rate-limit scope includes the subagent so routing changes
    // cannot be shadowed by a previous firing of the same team/trigger.
    const scope = `${trigger.team}:${subagentScope(effective)}`;
    if (this.opts.dedup.check(eventId, scope)) {
      this.opts.logger.info('Trigger dedup: skipping duplicate', { name: trigger.name, subagent: effective.subagent });
      return;
    }
    const rateResult = this.opts.rateLimiter.check(scope);
    if (!rateResult.allowed) {
      this.opts.logger.warn('Trigger rate limited', { name: trigger.name, subagent: effective.subagent, retryAfterMs: rateResult.retryAfterMs });
      return;
    }
    this.opts.dedup.record(eventId, scope);

    const policy = effective.overlapPolicy ?? 'skip-then-replace';
    if (evalOverlapPolicy(this.opts, trigger, effective, policy)) return;

    // Snapshot task options from the live trigger config — subagent must
    // flow to the task consumer so the session is run with the chosen agent.
    const options: TaskOptions | undefined =
      effective.maxSteps !== undefined || effective.skill !== undefined || effective.subagent !== undefined
        ? {
            maxSteps: effective.maxSteps,
            skill: effective.skill,
            subagent: effective.subagent,
          }
        : undefined;

    const taskId = await this.opts.delegateTask(
      trigger.team,
      effective.task ?? trigger.task,
      undefined,
      trigger.name,
      sourceChannelId,
      options,
    );
    if (policy !== 'allow') {
      this.opts.configStore?.setActiveTask(trigger.team, trigger.name, taskId);
    }
  }
}
