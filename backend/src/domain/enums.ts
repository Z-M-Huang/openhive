/**
 * OpenHive Backend - Domain Enums
 *
 * String literal union types for all domain enums.
 * Uses strings everywhere to match the wire protocol.
 *
 * Each enum provides:
 *   - A string literal union type
 *   - A const array of all valid values (for iteration)
 *   - A parse function that returns the typed value or throws an Error
 *   - A validate function that returns boolean
 */

// ---------------------------------------------------------------------------
// TaskStatus
// ---------------------------------------------------------------------------

/** Lifecycle state of a task. */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'escalated';

/** All valid TaskStatus values, in canonical order. */
export const TASK_STATUSES = ['pending', 'running', 'completed', 'failed', 'cancelled', 'escalated'] as const;

/**
 * Validates whether the given string is a valid TaskStatus.
 */
export function validateTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value);
}

/**
 * Parses a string into a TaskStatus.
 * Throws an Error if the value is not a known TaskStatus.
 */
export function parseTaskStatus(value: string): TaskStatus {
  if (validateTaskStatus(value)) {
    return value;
  }
  throw new Error(`invalid task status: "${value}"`);
}

// ---------------------------------------------------------------------------
// EventType
// ---------------------------------------------------------------------------

/** Type of an event emitted within the system. */
export type EventType =
  | 'task_created'
  | 'task_updated'
  | 'task_completed'
  | 'task_failed'
  | 'config_changed'
  | 'team_created'
  | 'team_deleted'
  | 'agent_started'
  | 'agent_stopped'
  | 'channel_message'
  | 'heartbeat_received'
  | 'container_state_changed'
  | 'log_entry'
  | 'task_cancelled';

/** All valid EventType values, in canonical order. */
export const EVENT_TYPES = [
  'task_created',
  'task_updated',
  'task_completed',
  'task_failed',
  'config_changed',
  'team_created',
  'team_deleted',
  'agent_started',
  'agent_stopped',
  'channel_message',
  'heartbeat_received',
  'container_state_changed',
  'log_entry',
  'task_cancelled',
] as const;

/**
 * Validates whether the given string is a valid EventType.
 */
export function validateEventType(value: string): value is EventType {
  return (EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Parses a string into an EventType.
 * Throws an Error if the value is not a known EventType.
 */
export function parseEventType(value: string): EventType {
  if (validateEventType(value)) {
    return value;
  }
  throw new Error(`invalid event type: "${value}"`);
}

// ---------------------------------------------------------------------------
// ProviderType
// ---------------------------------------------------------------------------

/** Type of AI provider. */
export type ProviderType = 'oauth' | 'anthropic_direct';

/** All valid ProviderType values, in canonical order. */
export const PROVIDER_TYPES = ['oauth', 'anthropic_direct'] as const;

/**
 * Validates whether the given string is a valid ProviderType.
 */
export function validateProviderType(value: string): value is ProviderType {
  return (PROVIDER_TYPES as readonly string[]).includes(value);
}

/**
 * Parses a string into a ProviderType.
 * Throws an Error if the value is not a known ProviderType.
 */
export function parseProviderType(value: string): ProviderType {
  if (validateProviderType(value)) {
    return value;
  }
  throw new Error(`invalid provider type: "${value}"`);
}

// ---------------------------------------------------------------------------
// LogLevel
// ---------------------------------------------------------------------------

/** Logging severity level. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** All valid LogLevel values, in canonical order. */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

/**
 * Validates whether the given string is a valid LogLevel.
 */
export function validateLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * Parses a string into a LogLevel.
 * Throws an Error if the value is not a known LogLevel.
 */
export function parseLogLevel(value: string): LogLevel {
  if (validateLogLevel(value)) {
    return value;
  }
  throw new Error(`invalid log level: "${value}"`);
}

// ---------------------------------------------------------------------------
// ContainerState
// ---------------------------------------------------------------------------

/** State of a Docker container. */
export type ContainerState =
  | 'creating'
  | 'created'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'removing'
  | 'removed'
  | 'failed';

/** All valid ContainerState values, in canonical order. */
export const CONTAINER_STATES = [
  'creating',
  'created',
  'starting',
  'running',
  'stopping',
  'stopped',
  'removing',
  'removed',
  'failed',
] as const;

/**
 * Validates whether the given string is a valid ContainerState.
 */
export function validateContainerState(value: string): value is ContainerState {
  return (CONTAINER_STATES as readonly string[]).includes(value);
}

/**
 * Parses a string into a ContainerState.
 * Throws an Error if the value is not a known ContainerState.
 */
export function parseContainerState(value: string): ContainerState {
  if (validateContainerState(value)) {
    return value;
  }
  throw new Error(`invalid container state: "${value}"`);
}

// ---------------------------------------------------------------------------
// ModelTier
// ---------------------------------------------------------------------------

/** Model capability tier. */
export type ModelTier = 'haiku' | 'sonnet' | 'opus';

/** All valid ModelTier values, in canonical order. */
export const MODEL_TIERS = ['haiku', 'sonnet', 'opus'] as const;

/**
 * Validates whether the given string is a valid ModelTier.
 */
export function validateModelTier(value: string): value is ModelTier {
  return (MODEL_TIERS as readonly string[]).includes(value);
}

/**
 * Parses a string into a ModelTier.
 * Throws an Error if the value is not a known ModelTier.
 */
export function parseModelTier(value: string): ModelTier {
  if (validateModelTier(value)) {
    return value;
  }
  throw new Error(`invalid model tier: "${value}"`);
}

// ---------------------------------------------------------------------------
// AgentStatusType
// ---------------------------------------------------------------------------

/** Runtime status of an agent. */
export type AgentStatusType = 'idle' | 'busy' | 'starting' | 'stopped' | 'error';

/** All valid AgentStatusType values, in canonical order. */
export const AGENT_STATUS_TYPES = ['idle', 'busy', 'starting', 'stopped', 'error'] as const;

/**
 * Validates whether the given string is a valid AgentStatusType.
 */
export function validateAgentStatusType(value: string): value is AgentStatusType {
  return (AGENT_STATUS_TYPES as readonly string[]).includes(value);
}

/**
 * Parses a string into an AgentStatusType.
 * Throws an Error if the value is not a known AgentStatusType.
 */
export function parseAgentStatusType(value: string): AgentStatusType {
  if (validateAgentStatusType(value)) {
    return value;
  }
  throw new Error(`invalid agent status type: "${value}"`);
}
