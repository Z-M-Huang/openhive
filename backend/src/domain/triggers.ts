/**
 * Trigger type definitions for OpenHive automation.
 * Uses discriminated union pattern for type-safe trigger configuration.
 */

export interface TriggerBase {
  name: string;
  team_slug: string;
  enabled?: boolean;
}

export interface CronTrigger extends TriggerBase {
  type: 'cron';
  schedule: string;
  prompt: string;
}

export interface WebhookTrigger extends TriggerBase {
  type: 'webhook';
  path: string;
  method?: string;
}

export interface ChannelEventTrigger extends TriggerBase {
  type: 'channel_event';
  pattern: string;
  channel_type?: string;
}

export interface TaskCompletionTrigger extends TriggerBase {
  type: 'task_completion';
  source_team?: string;
  status_filter?: string[];
}

export type TriggerConfig =
  | CronTrigger
  | WebhookTrigger
  | ChannelEventTrigger
  | TaskCompletionTrigger;

/**
 * Type guard to check if a trigger is enabled
 */
export function isTriggerEnabled(trigger: TriggerConfig): boolean {
  return trigger.enabled ?? true;
}

/**
 * Type guard for CronTrigger
 */
export function isCronTrigger(trigger: TriggerConfig): trigger is CronTrigger {
  return trigger.type === 'cron';
}

/**
 * Type guard for WebhookTrigger
 */
export function isWebhookTrigger(trigger: TriggerConfig): trigger is WebhookTrigger {
  return trigger.type === 'webhook';
}

/**
 * Type guard for ChannelEventTrigger
 */
export function isChannelEventTrigger(trigger: TriggerConfig): trigger is ChannelEventTrigger {
  return trigger.type === 'channel_event';
}

/**
 * Type guard for TaskCompletionTrigger
 */
export function isTaskCompletionTrigger(trigger: TriggerConfig): trigger is TaskCompletionTrigger {
  return trigger.type === 'task_completion';
}