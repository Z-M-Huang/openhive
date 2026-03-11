/**
 * Domain types for OpenHive.
 *
 * All 12 entity types derived from the canonical Database-Schema.md.
 * Includes ID/slug validation functions and task state machine logic.
 */

import {
  type ChannelType,
  type DecisionType,
  type IntegrationStatus,
  type LogLevel,
  type MemoryType,
  type TaskStatus,
  TaskStatus as TS,
} from './enums.js';

// ---------------------------------------------------------------------------
// Entity Types (12 total, matching DB schema)
// ---------------------------------------------------------------------------

/** tasks table — dispatched tasks with DAG tracking via blocked_by. */
export interface Task {
  id: string;
  parent_id: string;
  team_slug: string;
  agent_aid: string;
  title: string;
  status: TaskStatus;
  prompt: string;
  result: string;
  error: string;
  blocked_by: string[] | null;
  priority: number;
  retry_count: number;
  max_retries: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

/** agents — runtime agent config derived from agent definition files. */
export interface Agent {
  aid: string;
  name: string;
  description: string;
  team_slug: string;
  role: string;
  status: string;
  model: string;
  tools: string[];
}

/** teams — runtime team config derived from team.yaml files. */
export interface Team {
  tid: string;
  slug: string;
  leader_aid: string;
  parent_tid: string;
  depth: number;
  container_id: string;
  health: string;
  agent_aids: string[];
  workspace_path: string;
  created_at: number;
}

/** messages table — chat messages from messaging channels. */
export interface Message {
  id: string;
  chat_jid: string;
  role: string;
  content: string;
  type: string;
  timestamp: number;
}

/** log_entries table — unified log table for all events. */
export interface LogEntry {
  id: number;
  level: LogLevel;
  event_type: string;
  component: string;
  action: string;
  message: string;
  params: string;
  team_slug: string;
  task_id: string;
  agent_aid: string;
  request_id: string;
  correlation_id: string;
  error: string;
  duration_ms: number;
  created_at: number;
}

/** chat_sessions table — active chat sessions per messaging channel. */
export interface ChatSession {
  chat_jid: string;
  channel_type: ChannelType;
  last_timestamp: number;
  last_agent_timestamp: number;
  session_id: string;
  agent_aid: string;
}

/** task_events table — task lifecycle events (one per state transition). */
export interface TaskEvent {
  id: number;
  log_entry_id: number;
  task_id: string;
  from_status: string;
  to_status: string;
  agent_aid: string;
  reason: string;
  created_at: number;
}

/** tool_calls table — tool invocation records from SDK hooks. */
export interface ToolCall {
  id: number;
  log_entry_id: number;
  tool_use_id: string;
  tool_name: string;
  agent_aid: string;
  team_slug: string;
  task_id: string;
  params: string;
  result_summary: string;
  error: string;
  duration_ms: number;
  created_at: number;
}

/** decisions table — LLM decision points for audit trail. */
export interface Decision {
  id: number;
  log_entry_id: number;
  decision_type: DecisionType;
  agent_aid: string;
  task_id: string;
  chosen_action: string;
  alternatives: string;
  reasoning: string;
  created_at: number;
}

/** agent_memories table — searchable index for agent memory. */
export interface MemoryEntry {
  id: number;
  agent_aid: string;
  team_slug: string;
  content: string;
  memory_type: MemoryType;
  created_at: number;
  deleted_at: number | null;
}

/** integrations table — integration configurations. */
export interface Integration {
  id: string;
  team_id: string;
  name: string;
  config_path: string;
  status: IntegrationStatus;
  created_at: number;
}

/** credentials table — encrypted credentials scoped per-team. */
export interface Credential {
  id: string;
  name: string;
  encrypted_value: string;
  team_id: string;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Task State Machine (AC7)
// ---------------------------------------------------------------------------

/**
 * Valid task status transitions derived from Architecture.md state machine.
 *
 * pending   -> active, cancelled, escalated
 * active    -> completed, failed, cancelled, escalated
 * failed    -> pending (retry), escalated (no retries left)
 * escalated -> pending (lead resolves)
 * completed -> (terminal)
 * cancelled -> (terminal)
 */
const VALID_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  [TS.Pending]: new Set([TS.Active, TS.Cancelled, TS.Escalated]),
  [TS.Active]: new Set([TS.Completed, TS.Failed, TS.Cancelled, TS.Escalated]),
  [TS.Failed]: new Set([TS.Pending, TS.Escalated]),
  [TS.Escalated]: new Set([TS.Pending]),
  [TS.Completed]: new Set<TaskStatus>(),
  [TS.Cancelled]: new Set<TaskStatus>(),
};

/** Returns true if the transition from `from` to `to` is valid per the task state machine. */
export function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  const allowed = VALID_TRANSITIONS[from];
  return allowed !== undefined && allowed.has(to);
}

/**
 * Asserts that a task state transition is valid per AC7.
 * Throws a descriptive error identifying the invalid transition if it is not allowed.
 *
 * @throws {Error} If the transition from `from` to `to` is not in VALID_TRANSITIONS.
 */
export function assertValidTransition(from: TaskStatus, to: TaskStatus): void {
  if (!isValidTransition(from, to)) {
    const allowed = VALID_TRANSITIONS[from];
    const allowedStr = allowed ? [...allowed].join(', ') : 'none';
    throw new Error(
      `Invalid task state transition: ${from} → ${to}. ` +
      `Allowed transitions from '${from}': [${allowedStr}].`
    );
  }
}

// ---------------------------------------------------------------------------
// ID Format Validators (AC8)
// ---------------------------------------------------------------------------

const AID_PATTERN = /^aid-[a-z0-9]+-[a-z0-9]+$/;
const TID_PATTERN = /^tid-[a-z0-9]+-[a-z0-9]+$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 64;

/** Reserved slugs that cannot be used for team names. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'main',
  'admin',
  'system',
  'root',
  'openhive',
]);

/**
 * Validates an agent ID format (aid-xxx-xxx).
 * Throws a descriptive error if the format is invalid.
 */
export function validateAID(aid: string): void {
  if (!aid) {
    throw new Error('Agent ID must not be empty');
  }
  if (!AID_PATTERN.test(aid)) {
    throw new Error(
      `Invalid agent ID format: "${aid}". Expected format: aid-<segment>-<segment> (lowercase alphanumeric segments separated by hyphens)`
    );
  }
}

/**
 * Validates a team ID format (tid-xxx-xxx).
 * Throws a descriptive error if the format is invalid.
 */
export function validateTID(tid: string): void {
  if (!tid) {
    throw new Error('Team ID must not be empty');
  }
  if (!TID_PATTERN.test(tid)) {
    throw new Error(
      `Invalid team ID format: "${tid}". Expected format: tid-<segment>-<segment> (lowercase alphanumeric segments separated by hyphens)`
    );
  }
}

/**
 * Validates a slug format (lowercase alphanumeric with hyphens, not reserved).
 * Throws a descriptive error if the format is invalid or the slug is reserved.
 */
export function validateSlug(slug: string): void {
  if (!slug) {
    throw new Error('Slug must not be empty');
  }
  if (slug.length > MAX_SLUG_LENGTH) {
    throw new Error(
      `Slug too long: "${slug}" (${slug.length} chars). Maximum length is ${MAX_SLUG_LENGTH}`
    );
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(
      `Invalid slug format: "${slug}". Slugs must be lowercase alphanumeric with hyphens, cannot start or end with a hyphen`
    );
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new Error(
      `Reserved slug: "${slug}". The following slugs are reserved: ${[...RESERVED_SLUGS].join(', ')}`
    );
  }
}
