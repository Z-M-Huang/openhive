/**
 * Trigger type definitions for OpenHive automation.
 * Uses discriminated union pattern for type-safe trigger configuration.
 */

/**
 * Structured action payload for a trigger.
 * Provides a title, prompt, and priority for the dispatched task.
 */
export interface TriggerAction {
  title: string;
  prompt: string;
  priority: 'P0' | 'P1' | 'P2';
}

export interface TriggerBase {
  name: string;
  /** The target team slug for this trigger. */
  target_team: string;
  /**
   * @deprecated Use target_team instead. Kept for backward compatibility.
   * Will be removed in a future version.
   */
  team_slug?: string;
  /**
   * Optional AID of a specific agent to assign the triggered task to.
   * If omitted, the task is assigned to the team lead.
   */
  agent?: string;
  enabled?: boolean;
}

export interface CronTrigger extends TriggerBase {
  type: 'cron';
  schedule: string;
  /**
   * Action to execute when the trigger fires.
   * Accepts either a structured TriggerAction or a plain prompt string
   * (the latter is normalized to a TriggerAction with default title and P2 priority).
   */
  action: TriggerAction | string;
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