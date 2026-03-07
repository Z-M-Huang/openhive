/**
 * OpenHive Backend - WebSocket Message Types
 *
 * Defines the wire protocol envelope and all typed message interfaces.
 *
 * Naming rules:
 *   - Field names use snake_case to match the wire protocol.
 *   - Optional fields use the ? suffix.
 *   - JsonValue is a recursive JSON value union (from domain/types).
 *   - Duration fields are numbers (nanoseconds on the wire; callers are
 *     responsible for unit conversion if needed).
 *
 * Direction notation:
 *   - Backend-to-Container: CONTAINER_INIT, TASK_DISPATCH, SHUTDOWN, TOOL_RESULT
 *   - Container-to-Backend: READY, HEARTBEAT, TASK_RESULT, ESCALATION, TOOL_CALL,
 *     STATUS_UPDATE
 */

import type { JsonValue } from '../domain/types.js';

// ---------------------------------------------------------------------------
// Message type constants
// ---------------------------------------------------------------------------

/** Backend-to-Container message types */
export const MsgTypeContainerInit = 'container_init' as const;
export const MsgTypeTaskDispatch = 'task_dispatch' as const;
export const MsgTypeShutdown = 'shutdown' as const;
export const MsgTypeToolResult = 'tool_result' as const;

/** Backend-to-Container: hot-reload an agent into a running container */
export const MsgTypeAgentAdded = 'agent_added' as const;

/** Container-to-Backend message types */
export const MsgTypeReady = 'ready' as const;
export const MsgTypeHeartbeat = 'heartbeat' as const;
export const MsgTypeTaskResult = 'task_result' as const;
export const MsgTypeEscalation = 'escalation' as const;
export const MsgTypeToolCall = 'tool_call' as const;
export const MsgTypeStatusUpdate = 'status_update' as const;
/** Container-to-Backend: ack that an agent_added was processed */
export const MsgTypeAgentReady = 'agent_ready' as const;

// ---------------------------------------------------------------------------
// WS error code constants
// ---------------------------------------------------------------------------

export const WSErrorNotFound = 'NOT_FOUND' as const;
export const WSErrorValidation = 'VALIDATION_ERROR' as const;
export const WSErrorConflict = 'CONFLICT' as const;
export const WSErrorEncryptionLocked = 'ENCRYPTION_LOCKED' as const;
export const WSErrorRateLimited = 'RATE_LIMITED' as const;
export const WSErrorAccessDenied = 'ACCESS_DENIED' as const;
export const WSErrorInternal = 'INTERNAL_ERROR' as const;

/** Union of all WS error code strings. */
export type WSErrorCode =
  | typeof WSErrorNotFound
  | typeof WSErrorValidation
  | typeof WSErrorConflict
  | typeof WSErrorEncryptionLocked
  | typeof WSErrorRateLimited
  | typeof WSErrorAccessDenied
  | typeof WSErrorInternal;

// ---------------------------------------------------------------------------
// Backend-to-Container message data interfaces
// ---------------------------------------------------------------------------

/** Holds resolved provider credentials for a single agent. */
export interface ProviderConfig {
  type: string;
  api_key?: string;
  api_url?: string;
  oauth_token?: string;
}

/** Holds MCP server configuration sent to a container. */
export interface MCPServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Holds flattened agent config sent to containers. */
/** Agent role within a container (determines system prompt). */
export type AgentRole = 'assistant' | 'leader' | 'worker';

export interface AgentInitConfig {
  aid: string;
  name: string;
  provider: ProviderConfig;
  model_tier: string;
  skills?: string[];
  role?: AgentRole;
  leads_team?: string;
}

/** Carries initialization data for a team container. */
export interface ContainerInitMsg {
  is_main_assistant: boolean;
  team_config: JsonValue;
  agents: AgentInitConfig[];
  secrets?: Record<string, string>;
  mcp_servers?: MCPServerConfig[];
  workspace_root?: string;
}

/** Instructs a container to execute a task. */
export interface TaskDispatchMsg {
  task_id: string;
  agent_aid: string;
  prompt: string;
  session_id?: string;
  work_dir?: string;
}

/** Instructs a container to shut down gracefully. */
export interface ShutdownMsg {
  reason: string;
  timeout: number;
}

/** Carries the result of a tool call back to the container. */
export interface ToolResultMsg {
  call_id: string;
  result?: JsonValue;
  error_code?: string;
  error_message?: string;
}

// ---------------------------------------------------------------------------
// Container-to-Backend message data interfaces
// ---------------------------------------------------------------------------

/** Signals that a container has initialised and is ready. */
export interface ReadyMsg {
  team_id: string;
  agent_count: number;
}

/** Represents one agent's health in a heartbeat. */
export interface AgentStatus {
  aid: string;
  status: string;
  detail?: string;
  elapsed_seconds: number;
  memory_mb: number;
}

/** Carries periodic health data from a container. */
export interface HeartbeatMsg {
  team_id: string;
  agents: AgentStatus[];
}

/**
 * Carries the result of a completed task.
 * Duration is nanoseconds on the wire.
 */
export interface TaskResultMsg {
  task_id: string;
  agent_aid: string;
  status: string;
  result?: string;
  error?: string;
  files_created?: string[];
  duration: number;
}

/** Requests that a task be escalated to a supervisor. */
export interface EscalationMsg {
  task_id: string;
  agent_aid: string;
  reason: string;
  context?: string;
}

/** Sent by a container when an agent invokes an SDK tool. */
export interface ToolCallMsg {
  call_id: string;
  tool_name: string;
  arguments: JsonValue;
  agent_aid: string;
}

/** Carries an agent status change notification. */
export interface StatusUpdateMsg {
  agent_aid: string;
  status: string;
  detail?: string;
}

/**
 * Carries a new agent config to a running container for hot-reload.
 */
export interface AgentAddedMsg {
  agent: AgentInitConfig;
}

/**
 * Ack from a container that an agent_added was processed.
 */
export interface AgentReadyMsg {
  aid: string;
}

// ---------------------------------------------------------------------------
// WSMessage — discriminated union envelope
// ---------------------------------------------------------------------------

/**
 * WebSocket envelope for Backend-to-Container direction.
 * The 'type' field is the discriminator that narrows 'data' at compile time.
 */
export type GoToContainerMessage =
  | { type: typeof MsgTypeContainerInit; data: ContainerInitMsg }
  | { type: typeof MsgTypeTaskDispatch; data: TaskDispatchMsg }
  | { type: typeof MsgTypeShutdown; data: ShutdownMsg }
  | { type: typeof MsgTypeToolResult; data: ToolResultMsg }
  | { type: typeof MsgTypeAgentAdded; data: AgentAddedMsg };

/**
 * WebSocket envelope for Container-to-Backend direction.
 * The 'type' field is the discriminator that narrows 'data' at compile time.
 */
export type ContainerToGoMessage =
  | { type: typeof MsgTypeReady; data: ReadyMsg }
  | { type: typeof MsgTypeHeartbeat; data: HeartbeatMsg }
  | { type: typeof MsgTypeTaskResult; data: TaskResultMsg }
  | { type: typeof MsgTypeEscalation; data: EscalationMsg }
  | { type: typeof MsgTypeToolCall; data: ToolCallMsg }
  | { type: typeof MsgTypeStatusUpdate; data: StatusUpdateMsg }
  | { type: typeof MsgTypeAgentReady; data: AgentReadyMsg };

/**
 * Union of all WebSocket messages in both directions.
 * Use parseWSMessage() to obtain a correctly-typed WSMessage from a raw string.
 */
export type WSMessage = GoToContainerMessage | ContainerToGoMessage;

// ---------------------------------------------------------------------------
// All known message type strings (used in parseWSMessage)
// ---------------------------------------------------------------------------

const KNOWN_MSG_TYPES = new Set<string>([
  MsgTypeContainerInit,
  MsgTypeTaskDispatch,
  MsgTypeShutdown,
  MsgTypeToolResult,
  MsgTypeAgentAdded,
  MsgTypeReady,
  MsgTypeHeartbeat,
  MsgTypeTaskResult,
  MsgTypeEscalation,
  MsgTypeToolCall,
  MsgTypeStatusUpdate,
  MsgTypeAgentReady,
]);

// ---------------------------------------------------------------------------
// parseWSMessage
// ---------------------------------------------------------------------------

/**
 * Raw shape of a WebSocket envelope as it arrives from JSON.parse().
 * Both fields are present; data is JsonValue (parsed JSON, not raw string).
 */
interface RawEnvelope {
  type: string;
  data: JsonValue;
}

/**
 * Type guard for the raw envelope structure.
 * Parameter is `unknown` so the predicate can safely narrow to RawEnvelope.
 */
function isRawEnvelope(value: unknown): value is RawEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return typeof obj['type'] === 'string' && 'data' in obj;
}

/**
 * Parses a raw WebSocket message string into a strongly-typed WSMessage.
 *
 * @param raw - The raw JSON string received from the WebSocket.
 * @returns A correctly-typed WSMessage discriminated union variant.
 * @throws {Error} If the string is not valid JSON.
 * @throws {Error} If the envelope is missing required fields.
 * @throws {Error} If the message type is not a recognised WSMessage type.
 */
export function parseWSMessage(raw: string): WSMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`invalid WebSocket message: not valid JSON`);
  }

  if (!isRawEnvelope(parsed)) {
    throw new Error(
      `invalid WebSocket message: envelope must be an object with "type" (string) and "data" fields`,
    );
  }

  const { type, data } = parsed;

  if (!KNOWN_MSG_TYPES.has(type)) {
    throw new Error(`invalid WebSocket message: unrecognised message type "${type}"`);
  }

  // The type narrowing is sound: we checked that 'type' is one of the known
  // constants, so the cast to WSMessage is safe at runtime.  TypeScript can't
  // infer this automatically for Set.has(), so we use a double assertion here.
  return { type, data } as unknown as WSMessage;
}
