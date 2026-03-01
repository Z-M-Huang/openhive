/**
 * OpenHive Agent Runner - Shared type definitions
 *
 * These types mirror the Go domain types and WebSocket protocol messages.
 */

/** Agent status types matching Go enum */
export type AgentStatusType = 'idle' | 'busy' | 'starting' | 'stopped' | 'error';

/** Model tier types matching Go enum */
export type ModelTier = 'haiku' | 'sonnet' | 'opus';

/** Provider type */
export type ProviderType = 'oauth' | 'anthropic_direct';

/** Task status */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

// --- WebSocket Message Types ---

/** Go-to-Container message types */
export const MSG_TYPE_CONTAINER_INIT = 'container_init' as const;
export const MSG_TYPE_TASK_DISPATCH = 'task_dispatch' as const;
export const MSG_TYPE_SHUTDOWN = 'shutdown' as const;
export const MSG_TYPE_TOOL_RESULT = 'tool_result' as const;

/** Container-to-Go message types */
export const MSG_TYPE_READY = 'ready' as const;
export const MSG_TYPE_HEARTBEAT = 'heartbeat' as const;
export const MSG_TYPE_TASK_RESULT = 'task_result' as const;
export const MSG_TYPE_ESCALATION = 'escalation' as const;
export const MSG_TYPE_TOOL_CALL = 'tool_call' as const;
export const MSG_TYPE_STATUS_UPDATE = 'status_update' as const;

/** All valid message types */
export type MessageType =
  | typeof MSG_TYPE_CONTAINER_INIT
  | typeof MSG_TYPE_TASK_DISPATCH
  | typeof MSG_TYPE_SHUTDOWN
  | typeof MSG_TYPE_TOOL_RESULT
  | typeof MSG_TYPE_READY
  | typeof MSG_TYPE_HEARTBEAT
  | typeof MSG_TYPE_TASK_RESULT
  | typeof MSG_TYPE_ESCALATION
  | typeof MSG_TYPE_TOOL_CALL
  | typeof MSG_TYPE_STATUS_UPDATE;

/** WS error code constants */
export const WS_ERROR_NOT_FOUND = 'NOT_FOUND' as const;
export const WS_ERROR_VALIDATION = 'VALIDATION_ERROR' as const;
export const WS_ERROR_CONFLICT = 'CONFLICT' as const;
export const WS_ERROR_ENCRYPTION_LOCKED = 'ENCRYPTION_LOCKED' as const;
export const WS_ERROR_INTERNAL = 'INTERNAL_ERROR' as const;

/** Direction constants */
export const DIRECTION_GO_TO_CONTAINER = 'go_to_container' as const;
export const DIRECTION_CONTAINER_TO_GO = 'container_to_go' as const;

const GO_TO_CONTAINER_TYPES = new Set<string>([
  MSG_TYPE_CONTAINER_INIT,
  MSG_TYPE_TASK_DISPATCH,
  MSG_TYPE_SHUTDOWN,
  MSG_TYPE_TOOL_RESULT,
]);

const CONTAINER_TO_GO_TYPES = new Set<string>([
  MSG_TYPE_READY,
  MSG_TYPE_HEARTBEAT,
  MSG_TYPE_TASK_RESULT,
  MSG_TYPE_ESCALATION,
  MSG_TYPE_TOOL_CALL,
  MSG_TYPE_STATUS_UPDATE,
]);

// --- WebSocket Message Envelope ---

/** WebSocket message envelope */
export interface WSMessage {
  type: MessageType;
  data: unknown;
}

// --- Go-to-Container Messages ---

/** Agent configuration received during container init */
export interface AgentInitConfig {
  aid: string;
  name: string;
  roleFile?: string;
  promptFile?: string;
  provider: ProviderConfig;
  modelTier: ModelTier;
  skills?: string[];
}

/** Flattened provider configuration */
export interface ProviderConfig {
  type: ProviderType;
  apiKey?: string;
  apiUrl?: string;
  oauthToken?: string;
}

/** MCP server configuration */
export interface MCPServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Container initialization message */
export interface ContainerInitMsg {
  isMainAssistant: boolean;
  teamConfig: unknown;
  agents: AgentInitConfig[];
  secrets?: Record<string, string>;
  mcpServers?: MCPServerConfig[];
}

/** Task dispatch message */
export interface TaskDispatchMsg {
  taskId: string;
  agentAid: string;
  prompt: string;
  sessionId?: string;
  workDir?: string;
}

/** Shutdown message */
export interface ShutdownMsg {
  reason: string;
  timeout: number;
}

/** Tool result message */
export interface ToolResultMsg {
  callId: string;
  result?: unknown;
  errorCode?: string;
  errorMessage?: string;
}

// --- Container-to-Go Messages ---

/** Ready message */
export interface ReadyMsg {
  teamId: string;
  agentCount: number;
}

/** Agent status reported in heartbeat */
export interface AgentStatus {
  aid: string;
  status: AgentStatusType;
  detail?: string;
  elapsedSeconds: number;
  memoryMB: number;
}

/** Heartbeat message */
export interface HeartbeatMsg {
  teamId: string;
  agents: AgentStatus[];
}

/** Task result message (container-to-Go) */
export interface TaskResultMsg {
  taskId: string;
  agentAid: string;
  status: TaskStatus;
  result?: string;
  error?: string;
  filesCreated?: string[];
  duration: number;
}

/** Escalation message */
export interface EscalationMsg {
  taskId: string;
  agentAid: string;
  reason: string;
  context?: string;
}

/** Tool call message */
export interface ToolCallMsg {
  callId: string;
  toolName: string;
  arguments: unknown;
  agentAid: string;
}

/** Status update message */
export interface StatusUpdateMsg {
  agentAid: string;
  status: AgentStatusType;
  detail?: string;
}

// --- Parse Function ---

/**
 * Parses a raw WebSocket message into a typed message.
 * Returns the message type and data, or throws on invalid input.
 */
export function parseMessage(raw: string | Buffer): WSMessage {
  const str = typeof raw === 'string' ? raw : raw.toString('utf-8');
  const envelope = JSON.parse(str) as WSMessage;

  if (!envelope.type) {
    throw new Error('message type is required');
  }

  if (!GO_TO_CONTAINER_TYPES.has(envelope.type) && !CONTAINER_TO_GO_TYPES.has(envelope.type)) {
    throw new Error(`unknown message type: ${envelope.type}`);
  }

  return envelope;
}

/**
 * Validates message direction.
 * Returns true if the message is valid for the given direction.
 */
export function validateDirection(
  msgType: string,
  direction: typeof DIRECTION_GO_TO_CONTAINER | typeof DIRECTION_CONTAINER_TO_GO,
): boolean {
  if (direction === DIRECTION_GO_TO_CONTAINER) {
    return GO_TO_CONTAINER_TYPES.has(msgType);
  }
  return CONTAINER_TO_GO_TYPES.has(msgType);
}
