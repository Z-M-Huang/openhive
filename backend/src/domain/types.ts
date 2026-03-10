/**
 * OpenHive Backend - Domain Types
 *
 * TypeScript interfaces for all domain types and config types.
 *
 * Field naming rules:
 *   - Field names use snake_case to match the wire protocol.
 *   - Optional fields use the ? suffix.
 *
 * TypeScript strict mode is enforced throughout — no 'any' or 'unknown'.
 */

import type {
  TaskStatus,
  EventType,
  LogLevel,
  ContainerState,
  AgentStatusType,
} from './enums.js';

// ---------------------------------------------------------------------------
// JsonValue — recursive JSON value type
// ---------------------------------------------------------------------------

/**
 * Represents any value that can appear in a JSON document.
 * Recursive to support arbitrarily nested structures.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

/** Represents a team of agents running in a Docker container. */
export interface Team {
  tid: string;
  slug: string;
  parent_slug?: string;
  leader_aid: string;
  children?: string[];
  agents?: Agent[];
  mcp_servers?: MCPServer[];
  env_vars?: Record<string, string>;
  container_config?: ContainerConfig;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

/** Represents a Claude Agent SDK instance. */
export interface Agent {
  aid: string;
  name: string;
  provider?: string;
  model_tier?: string;
  skills?: string[];
  max_turns?: number;
  timeout_minutes?: number;
  leads_team?: string;
  /** Proactive check interval in minutes. 0 = disabled, min 5. Default 30. */
  proactive_interval_minutes?: number;
  /** Whether the agent can self-evolve its own definition. Informational for v0. */
  self_evolve?: boolean;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** Represents an AI provider configuration. */
export interface Provider {
  name: string;
  type: string;
  base_url?: string;
  api_key?: string;
  oauth_token?: string;
  models?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Skill
// ---------------------------------------------------------------------------

/** Represents a skill assigned to an agent. */
export interface Skill {
  name: string;
  description?: string;
  model_tier?: string;
  tools?: string[];
  system_prompt_addition?: string;
}

// ---------------------------------------------------------------------------
// SkillInfo (registry metadata)
// ---------------------------------------------------------------------------

/** Metadata about a skill available in an external registry. */
export interface SkillInfo {
  name: string;
  description: string;
  registry_url: string;
  source_url: string;
}

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

/** Represents a unit of work dispatched to a team. */
export interface Task {
  id: string;
  parent_id?: string;
  team_slug: string;
  agent_aid?: string;
  jid?: string;
  status: TaskStatus;
  prompt: string;
  result?: string;
  error?: string;
  /** ID of the task that blocks this one (empty = not blocked). @deprecated Use blocked_by array instead. */
  blocked_by_task_id?: string;
  /** Task IDs that must complete before this task can start. Empty array if no dependencies. */
  blocked_by: string[];
  /** Priority level (higher = more important, default 0). */
  priority: number;
  /** Number of times this task has been retried. */
  retry_count: number;
  /** Maximum number of retries allowed (0 = no retries). */
  max_retries: number;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

// ---------------------------------------------------------------------------
// TaskResult
// ---------------------------------------------------------------------------

/**
 * Represents the result of a completed task.
 * duration is serialized as number (milliseconds).
 */
export interface TaskResult {
  task_id: string;
  status: TaskStatus;
  result?: string;
  error?: string;
  files_created?: string[];
  /** Duration in milliseconds. */
  duration: number;
}

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

/** Represents a chat message. */
export interface Message {
  id: string;
  chat_jid: string;
  role: string;
  content: string;
  timestamp: Date;
}

// ---------------------------------------------------------------------------
// ChatSession
// ---------------------------------------------------------------------------

/** Represents an active chat session. */
export interface ChatSession {
  chat_jid: string;
  channel_type: string;
  last_timestamp: Date;
  last_agent_timestamp: Date;
  session_id?: string;
  agent_aid?: string;
}

// ---------------------------------------------------------------------------
// LogEntry
// ---------------------------------------------------------------------------

/**
 * Represents a structured log entry stored in the database.
 * params is typed as JsonValue.
 */
export interface LogEntry {
  id: number;
  level: LogLevel;
  component: string;
  action: string;
  message: string;
  params?: JsonValue;
  team_name?: string;
  task_id?: string;
  agent_name?: string;
  request_id?: string;
  error?: string;
  duration_ms?: number;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

/** Status of an escalation request. */
export type EscalationStatus = 'pending' | 'resolved' | 'rejected' | 'timed_out';

/** Represents an escalation from an agent to its supervisor. */
export interface Escalation {
  id: string;
  correlation_id: string;
  task_id: string;
  from_aid: string;
  to_aid: string;
  source_team: string;
  destination_team: string;
  escalation_level: number;
  reason: string;
  context?: string;
  status: EscalationStatus;
  resolution?: string;
  created_at: Date;
  updated_at: Date;
  resolved_at: Date | null;
}

// ---------------------------------------------------------------------------
// AgentMemory
// ---------------------------------------------------------------------------

/** Represents a persistent memory entry for an agent. */
export interface AgentMemory {
  id: string;
  agent_aid: string;
  key: string;
  value: string;
  metadata?: string;
  /** Team slug this memory belongs to (empty = global). */
  team_slug?: string;
  /** Soft-delete timestamp (null = active). */
  deleted_at?: Date;
  created_at: Date;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

/** Represents an automated trigger configuration. */
export interface Trigger {
  id: string;
  name: string;
  team_slug: string;
  agent_aid: string;
  /** Cron expression (e.g. "0 0/5 * * *"). */
  schedule: string;
  prompt: string;
  enabled: boolean;
  /** Trigger type: 'cron' (default), 'webhook', 'channel_event', or 'task_completion'. */
  type?: 'cron' | 'webhook' | 'channel_event' | 'task_completion';
  /** Webhook path for webhook triggers (validated with validateSlug). */
  webhook_path?: string;
  /** Channel name for channel_event triggers. */
  channel?: string;
  /** Regex pattern for channel_event triggers (matched against message content). */
  pattern?: string;
  /** Source team slug for task_completion triggers (fires when a task in this team completes). */
  source_task_team?: string;
  last_run_at: Date | null;
  next_run_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// MCPServer
// ---------------------------------------------------------------------------

/** Represents an MCP server configuration. */
export interface MCPServer {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// ContainerConfig
// ---------------------------------------------------------------------------

/** Holds per-container Docker configuration. */
export interface ContainerConfig {
  max_memory?: string;
  max_old_space?: number;
  idle_timeout?: string;
  env?: Record<string, string>;
  /** Set at runtime, not in config files. */
  name?: string;
  /** Set at runtime, not in config files. */
  image_name?: string;
  /** Docker volume bind mounts (host:container[:mode]). Set at runtime. */
  binds?: string[];
}

// ---------------------------------------------------------------------------
// ContainerInfo
// ---------------------------------------------------------------------------

/** Holds information about a running container. */
export interface ContainerInfo {
  id: string;
  name: string;
  state: ContainerState;
}

// ---------------------------------------------------------------------------
// AgentHeartbeatStatus
// ---------------------------------------------------------------------------

/** Represents agent status in a heartbeat message. */
export interface AgentHeartbeatStatus {
  aid: string;
  status: AgentStatusType;
  detail: string;
  elapsed_seconds: number;
  memory_mb: number;
}

// ---------------------------------------------------------------------------
// HeartbeatStatus
// ---------------------------------------------------------------------------

/** Holds the latest heartbeat information for a team. */
export interface HeartbeatStatus {
  team_id: string;
  agents: AgentHeartbeatStatus[];
  last_seen: Date;
  is_healthy: boolean;
}

// ---------------------------------------------------------------------------
// EventPayload — discriminated union
// ---------------------------------------------------------------------------

/**
 * Payload for task_created events.
 * Carries the newly created task.
 */
export interface TaskCreatedPayload {
  kind: 'task_created';
  task: Task;
}

/**
 * Payload for task_updated events.
 * Carries the updated task.
 */
export interface TaskUpdatedPayload {
  kind: 'task_updated';
  task: Task;
}

/**
 * Payload for task_completed events.
 * Carries the task_id and the final result.
 */
export interface TaskCompletedPayload {
  kind: 'task_completed';
  task_id: string;
  result: TaskResult;
}

/**
 * Payload for task_failed events.
 * Carries the task_id and the error message.
 */
export interface TaskFailedPayload {
  kind: 'task_failed';
  task_id: string;
  error: string;
}

/**
 * Payload for task_cancelled events.
 * Carries the task_id.
 */
export interface TaskCancelledPayload {
  kind: 'task_cancelled';
  task_id: string;
}

/**
 * Payload for config_changed events.
 * Carries the config path that changed.
 */
export interface ConfigChangedPayload {
  kind: 'config_changed';
  path: string;
}

/**
 * Payload for team_created events.
 * Carries the new team_id (TID).
 */
export interface TeamCreatedPayload {
  kind: 'team_created';
  team_id: string;
}

/**
 * Payload for team_deleted events.
 * Carries the deleted team_id (TID).
 */
export interface TeamDeletedPayload {
  kind: 'team_deleted';
  team_id: string;
}

/**
 * Payload for agent_started events.
 * Carries the agent AID and its parent team_id.
 */
export interface AgentStartedPayload {
  kind: 'agent_started';
  aid: string;
  team_id: string;
}

/**
 * Payload for agent_stopped events.
 * Carries the agent AID and its parent team_id.
 */
export interface AgentStoppedPayload {
  kind: 'agent_stopped';
  aid: string;
  team_id: string;
}

/**
 * Payload for channel_message events.
 * Carries the originating JID and message content.
 */
export interface ChannelMessagePayload {
  kind: 'channel_message';
  jid: string;
  content: string;
  /** Channel name (e.g. 'discord', 'whatsapp'). Used by channel_event triggers to filter. */
  channel?: string;
}

/**
 * Payload for heartbeat_received events.
 * Carries the team_id and the full heartbeat status snapshot.
 */
export interface HeartbeatReceivedPayload {
  kind: 'heartbeat_received';
  team_id: string;
  status: HeartbeatStatus;
}

/**
 * Payload for container_state_changed events.
 * Carries the team_id and the new container state.
 */
export interface ContainerStateChangedPayload {
  kind: 'container_state_changed';
  team_id: string;
  state: ContainerState;
}

/**
 * Payload for log_entry events.
 * Carries the full log entry.
 */
export interface LogEntryPayload {
  kind: 'log_entry';
  entry: LogEntry;
}

/**
 * Discriminated union of all event payload types.
 * The 'kind' field matches the EventType string value, enabling exhaustive
 * type narrowing in switch statements.
 */
export type EventPayload =
  | TaskCreatedPayload
  | TaskUpdatedPayload
  | TaskCompletedPayload
  | TaskFailedPayload
  | TaskCancelledPayload
  | ConfigChangedPayload
  | TeamCreatedPayload
  | TeamDeletedPayload
  | AgentStartedPayload
  | AgentStoppedPayload
  | ChannelMessagePayload
  | HeartbeatReceivedPayload
  | ContainerStateChangedPayload
  | LogEntryPayload;

// ---------------------------------------------------------------------------
// Event
// ---------------------------------------------------------------------------

/**
 * Represents a system event for the event bus.
 * Payload is typed as the discriminated union EventPayload.
 */
export interface Event {
  type: EventType;
  payload: EventPayload;
}

// ---------------------------------------------------------------------------
// LogQueryOpts
// ---------------------------------------------------------------------------

/** Defines query parameters for log retrieval. */
export interface LogQueryOpts {
  level?: LogLevel;
  component?: string;
  team_name?: string;
  agent_name?: string;
  task_id?: string;
  since?: Date | null;
  until?: Date | null;
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

/** Holds the top-level system configuration. */
export interface MasterConfig {
  system: SystemConfig;
  assistant: AssistantConfig;
  agents?: Agent[];
  channels: ChannelsConfig;
  /** External skill registry URLs (e.g. ["https://clawhub.ai/skills"]). */
  skill_registries?: string[];
}

/** Configurable system limits (see Design Rules CON-01..CON-03). */
export interface SystemLimits {
  /** Maximum team nesting depth (CON-01, default 5). */
  max_depth: number;
  /** Maximum total teams across all depths (CON-02, default 20). */
  max_teams: number;
  /** Maximum agents per team (CON-03, default 10). */
  max_agents_per_team: number;
  /** Maximum concurrent running tasks (default 50). */
  max_concurrent_tasks: number;
}

/** Holds system-wide settings. */
export interface SystemConfig {
  listen_address: string;
  data_dir: string;
  workspace_root: string;
  log_level: string;
  log_archive: ArchiveConfig;
  max_message_length: number;
  default_idle_timeout: string;
  event_bus_workers: number;
  portal_ws_max_connections: number;
  message_archive: ArchiveConfig;
  limits: SystemLimits;
}

/** Holds log / message archive settings. */
export interface ArchiveConfig {
  enabled: boolean;
  max_entries: number;
  keep_copies: number;
  archive_dir: string;
}

/** Holds main assistant settings. */
export interface AssistantConfig {
  name: string;
  aid: string;
  provider: string;
  model_tier: string;
  max_turns: number;
  timeout_minutes: number;
}

/** Holds messaging channel settings. */
export interface ChannelsConfig {
  discord: ChannelConfig;
  whatsapp: ChannelConfig;
}

/** Holds settings for a single messaging channel. */
export interface ChannelConfig {
  enabled: boolean;
  token?: string;
  channel_id?: string;
  store_path?: string;
}
