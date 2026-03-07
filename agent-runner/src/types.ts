/**
 * OpenHive Agent Runner - Shared type definitions
 *
 * These types mirror the backend domain types and WebSocket protocol messages.
 */

/** Agent status types matching backend enum */
export type AgentStatusType = 'idle' | 'busy' | 'starting' | 'stopped' | 'error';

/** Model tier types matching backend enum */
export type ModelTier = 'haiku' | 'sonnet' | 'opus';

/** Provider type */
export type ProviderType = 'oauth' | 'anthropic_direct';

/** Task status */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/** JSON-compatible primitive types */
export type JSONPrimitive = string | number | boolean | null;

/**
 * Recursive JSON value type. Represents any valid JSON structure.
 * Used at serialization boundaries and for genuinely unstructured JSON data.
 */
export type JSONValue = JSONPrimitive | JSONValue[] | { [key: string]: JSONValue };

// --- WebSocket Message Types ---

/** Backend-to-Container message types */
export const MSG_TYPE_CONTAINER_INIT = 'container_init' as const;
export const MSG_TYPE_TASK_DISPATCH = 'task_dispatch' as const;
export const MSG_TYPE_SHUTDOWN = 'shutdown' as const;
export const MSG_TYPE_TOOL_RESULT = 'tool_result' as const;
export const MSG_TYPE_AGENT_ADDED = 'agent_added' as const;

/** Container-to-Backend message types */
export const MSG_TYPE_READY = 'ready' as const;
export const MSG_TYPE_HEARTBEAT = 'heartbeat' as const;
export const MSG_TYPE_TASK_RESULT = 'task_result' as const;
export const MSG_TYPE_ESCALATION = 'escalation' as const;
export const MSG_TYPE_TOOL_CALL = 'tool_call' as const;
export const MSG_TYPE_STATUS_UPDATE = 'status_update' as const;
export const MSG_TYPE_AGENT_READY = 'agent_ready' as const;

/** All valid message types */
export type MessageType =
  | typeof MSG_TYPE_CONTAINER_INIT
  | typeof MSG_TYPE_TASK_DISPATCH
  | typeof MSG_TYPE_SHUTDOWN
  | typeof MSG_TYPE_TOOL_RESULT
  | typeof MSG_TYPE_AGENT_ADDED
  | typeof MSG_TYPE_READY
  | typeof MSG_TYPE_HEARTBEAT
  | typeof MSG_TYPE_TASK_RESULT
  | typeof MSG_TYPE_ESCALATION
  | typeof MSG_TYPE_TOOL_CALL
  | typeof MSG_TYPE_STATUS_UPDATE
  | typeof MSG_TYPE_AGENT_READY;

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
  MSG_TYPE_AGENT_ADDED,
]);

const CONTAINER_TO_GO_TYPES = new Set<string>([
  MSG_TYPE_READY,
  MSG_TYPE_HEARTBEAT,
  MSG_TYPE_TASK_RESULT,
  MSG_TYPE_ESCALATION,
  MSG_TYPE_TOOL_CALL,
  MSG_TYPE_STATUS_UPDATE,
  MSG_TYPE_AGENT_READY,
]);

// --- WebSocket Message Envelope ---

/** Union of all valid WebSocket message data types */
export type WSMessageData =
  | ContainerInitMsg
  | TaskDispatchMsg
  | ShutdownMsg
  | ToolResultMsg
  | AgentAddedMsg
  | ReadyMsg
  | HeartbeatMsg
  | TaskResultMsg
  | EscalationMsg
  | ToolCallMsg
  | StatusUpdateMsg
  | AgentReadyMsg;

/** WebSocket message envelope */
export interface WSMessage {
  type: MessageType;
  data: WSMessageData;
}

// --- Backend-to-Container Messages ---

/** Agent role within a container (determines system prompt). */
export type AgentRole = 'assistant' | 'leader' | 'worker';

/** Agent configuration received during container init */
export interface AgentInitConfig {
  aid: string;
  name: string;
  provider: ProviderConfig;
  modelTier: ModelTier;
  skills?: string[];
  role?: AgentRole;
  leadsTeam?: string;
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
  teamConfig: Record<string, JSONValue>;
  agents: AgentInitConfig[];
  secrets?: Record<string, string>;
  mcpServers?: MCPServerConfig[];
  workspaceRoot?: string;
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
  result?: JSONValue;
  errorCode?: string;
  errorMessage?: string;
}

// --- Container-to-Backend Messages ---

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
  memoryMb: number;
}

/** Heartbeat message */
export interface HeartbeatMsg {
  teamId: string;
  agents: AgentStatus[];
}

/** Task result message (container-to-backend) */
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
  arguments: Record<string, JSONValue>;
  agentAid: string;
}

/** Status update message */
export interface StatusUpdateMsg {
  agentAid: string;
  status: AgentStatusType;
  detail?: string;
}

/** Agent added message (backend-to-container: hot-reload a new agent) */
export interface AgentAddedMsg {
  agent: AgentInitConfig;
}

/** Agent ready message (container-to-backend: ack that agent_added was processed) */
export interface AgentReadyMsg {
  aid: string;
}

// --- Wire Format Conversion ---

/**
 * Convert a camelCase key to snake_case.
 * Example: "teamId" → "team_id", "isMainAssistant" → "is_main_assistant"
 */
function camelToSnakeKey(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Convert a snake_case key to camelCase.
 * Example: "team_id" → "teamId", "is_main_assistant" → "isMainAssistant"
 */
function snakeToCamelKey(key: string): string {
  return key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/**
 * Recursively convert all object keys using the given converter function.
 * Arrays are traversed, primitives are returned as-is.
 */
function deepConvertKeys(obj: JSONValue, converter: (key: string) => string): JSONValue {
  if (Array.isArray(obj)) {
    return obj.map((item) => deepConvertKeys(item, converter));
  }
  if (obj !== null && typeof obj === 'object') {
    const result: { [key: string]: JSONValue } = {};
    for (const [key, value] of Object.entries(obj)) {
      result[converter(key)] = deepConvertKeys(value, converter);
    }
    return result;
  }
  return obj;
}

/**
 * Convert a camelCase message to snake_case for the wire protocol.
 * Used by ws-client before JSON.stringify.
 */
export function toWireFormat(msg: WSMessage): JSONValue {
  // WSMessage types are pure data interfaces — always JSON-serializable.
  // JSON round-trip converts typed interfaces to plain JSONValue at the serialization boundary.
  const plain: JSONValue = JSON.parse(JSON.stringify(msg));
  return deepConvertKeys(plain, camelToSnakeKey);
}

// --- Parse Function ---

/**
 * Parses a raw WebSocket message into a typed message.
 * Converts snake_case wire keys to camelCase TypeScript keys.
 * Validates the message type and constructs a typed WSMessage.
 */
export function parseMessage(raw: string | Buffer): WSMessage {
  const str = typeof raw === 'string' ? raw : raw.toString('utf-8');
  const wireEnvelope: JSONValue = JSON.parse(str);
  const converted = deepConvertKeys(wireEnvelope, snakeToCamelKey);

  if (typeof converted !== 'object' || converted === null || Array.isArray(converted)) {
    throw new Error('Expected JSON object for wire message');
  }

  const msgType = converted.type;
  if (typeof msgType !== 'string' || !msgType) {
    throw new Error('message type is required');
  }

  if (!GO_TO_CONTAINER_TYPES.has(msgType) && !CONTAINER_TO_GO_TYPES.has(msgType)) {
    throw new Error(`unknown message type: ${msgType}`);
  }

  const msgData = converted.data;
  if (typeof msgData !== 'object' || msgData === null || Array.isArray(msgData)) {
    throw new Error('message data must be an object');
  }

  // At the deserialization boundary: type string is validated above,
  // data is a JSON object that structurally matches the corresponding WSMessageData variant.
  // Assert through 'object' (base type for all non-primitives) to bridge the gap
  // between index-signatured JSON objects and specific typed interfaces.
  return {
    type: msgType as MessageType,
    data: msgData as object as WSMessageData,
  };
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
