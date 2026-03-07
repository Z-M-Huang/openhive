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
  skills?: Skill[];
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
