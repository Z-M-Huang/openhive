/**
 * WebSocket protocol types for OpenHive.
 *
 * Defines all 16 message types from WebSocket-Protocol.md:
 *   7 root-to-container: container_init, task_dispatch, shutdown, tool_result,
 *                        agent_added, escalation_response, task_cancel
 *   9 container-to-root: ready, heartbeat, task_result, escalation, log_event,
 *                        tool_call, status_update, agent_ready, org_chart_update
 *
 * Wire protocol message types and their top-level fields use snake_case throughout.
 * Nested domain types (AgentInitConfig, ResolvedProvider) retain camelCase field names
 * from domain/interfaces.ts — wire-specific snake_case conversion is deferred to L4.
 * toWireFormat() serializes directly; parseMessage() validates and deserializes.
 */

import type {
  AgentInitConfig,
  MCPServerConfig,
} from '../domain/interfaces.js';

import type {
  AgentStatus,
  EscalationReason,
  WSErrorCode,
} from '../domain/enums.js';

import { ValidationError } from '../domain/errors.js';
import { z } from 'zod';

// Re-export for single import point
export { mapDomainErrorToWSError } from '../domain/errors.js';

// ---------------------------------------------------------------------------
// JSON value type (recursive)
// ---------------------------------------------------------------------------

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Zod schemas for message payload validation (AC-L4-08)
// ---------------------------------------------------------------------------

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(JsonValueSchema), z.record(JsonValueSchema)])
);

// Root-to-Container message schemas

export const ContainerInitSchema = z.object({
  protocol_version: z.string().min(1),
  is_main_assistant: z.boolean(),
  team_config: JsonValueSchema,
  agents: z.array(z.any()), // AgentInitConfig validated at higher layer
  secrets: z.record(z.string()).optional(),
  mcp_servers: z.array(z.any()).optional(), // MCPServerConfig validated at higher layer
});

export const TaskDispatchSchema = z.object({
  task_id: z.string().min(1),
  agent_aid: z.string().min(1),
  prompt: z.string(),
  session_id: z.string().optional(),
  work_dir: z.string().optional(),
  blocked_by: z.array(z.string()),
});

export const ShutdownSchema = z.object({
  reason: z.string(),
  timeout: z.number().int().nonnegative(),
});

export const ToolResultSchema = z.object({
  call_id: z.string().min(1),
  result: JsonValueSchema.optional(),
  error_code: z.string().optional(),
  error_message: z.string().optional(),
});

export const AgentAddedSchema = z.object({
  agent: z.any(), // AgentInitConfig validated at higher layer
});

export const EscalationResponseSchema = z.object({
  correlation_id: z.string().min(1),
  task_id: z.string().min(1),
  agent_aid: z.string().min(1),
  source_team: z.string().min(1),
  destination_team: z.string().min(1),
  resolution: z.string(),
  context: z.record(JsonValueSchema),
});

export const TaskCancelSchema = z.object({
  task_id: z.string().min(1),
  cascade: z.boolean(),
  reason: z.string().optional(),
});

// Container-to-Root message schemas

export const ReadySchema = z.object({
  team_id: z.string().min(1),
  agent_count: z.number().int().nonnegative(),
  protocol_version: z.string().min(1),
});

export const AgentStatusInfoSchema = z.object({
  aid: z.string().min(1),
  status: z.string().min(1), // AgentStatus enum
  detail: z.string(),
  elapsed_seconds: z.number().int().nonnegative(),
  memory_mb: z.number().nonnegative(),
});

export const HeartbeatSchema = z.object({
  team_id: z.string().min(1),
  agents: z.array(AgentStatusInfoSchema),
});

export const TaskResultSchema = z.object({
  task_id: z.string().min(1),
  agent_aid: z.string().min(1),
  status: z.enum(['completed', 'failed']),
  result: z.string().optional(),
  error: z.string().optional(),
  files_created: z.array(z.string()).optional(),
  duration: z.number().nonnegative(),
});

export const EscalationSchema = z.object({
  correlation_id: z.string().min(1),
  task_id: z.string().min(1),
  agent_aid: z.string().min(1),
  source_team: z.string().min(1),
  destination_team: z.string().min(1),
  escalation_level: z.number().int().nonnegative(),
  reason: z.string().min(1), // EscalationReason enum
  context: z.record(JsonValueSchema),
});

export const LogEventSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']),
  source_aid: z.string().min(1),
  message: z.string(),
  metadata: z.record(JsonValueSchema),
  timestamp: z.string().min(1),
});

export const ToolCallSchema = z.object({
  call_id: z.string().min(1),
  tool_name: z.string().min(1),
  arguments: JsonValueSchema,
  agent_aid: z.string().min(1),
});

export const StatusUpdateSchema = z.object({
  agent_aid: z.string().min(1),
  status: z.string().min(1), // AgentStatus enum
  detail: z.string().optional(),
});

export const AgentReadySchema = z.object({
  aid: z.string().min(1),
});

export const OrgChartUpdateSchema = z.object({
  action: z.enum(['agent_added', 'agent_removed', 'team_created', 'team_deleted']),
  team_slug: z.string().min(1),
  agent_aid: z.string().optional(),
  agent_name: z.string().optional(),
  timestamp: z.string().min(1),
});

// Message type to schema mapping
const MESSAGE_SCHEMAS: Record<string, z.ZodType> = {
  container_init: ContainerInitSchema,
  task_dispatch: TaskDispatchSchema,
  shutdown: ShutdownSchema,
  tool_result: ToolResultSchema,
  agent_added: AgentAddedSchema,
  escalation_response: EscalationResponseSchema,
  task_cancel: TaskCancelSchema,
  ready: ReadySchema,
  heartbeat: HeartbeatSchema,
  task_result: TaskResultSchema,
  escalation: EscalationSchema,
  log_event: LogEventSchema,
  tool_call: ToolCallSchema,
  status_update: StatusUpdateSchema,
  agent_ready: AgentReadySchema,
  org_chart_update: OrgChartUpdateSchema,
};

// ---------------------------------------------------------------------------
// Org Chart Action (org_chart_update message)
// ---------------------------------------------------------------------------

export const OrgChartAction = {
  AgentAdded: 'agent_added',
  AgentRemoved: 'agent_removed',
  TeamCreated: 'team_created',
  TeamDeleted: 'team_deleted',
} as const;

export type OrgChartAction = (typeof OrgChartAction)[keyof typeof OrgChartAction];

// ---------------------------------------------------------------------------
// Root-to-Container message payloads (7 types)
// ---------------------------------------------------------------------------

/** container_init -- sent once after WS establishment. */
export interface ContainerInitMsg {
  protocol_version: string;
  is_main_assistant: boolean;
  team_config: JsonValue;
  agents: AgentInitConfig[];
  secrets?: Record<string, string>;
  mcp_servers?: MCPServerConfig[];
}

/** task_dispatch -- task assignment to a specific agent. */
export interface TaskDispatchMsg {
  task_id: string;
  agent_aid: string;
  prompt: string;
  session_id?: string;
  work_dir?: string;
  blocked_by: string[];
}

/** shutdown -- graceful shutdown request. */
export interface ShutdownMsg {
  reason: string;
  timeout: number;
}

/** tool_result -- response to a tool_call. */
export interface ToolResultMsg {
  call_id: string;
  result?: JsonValue;
  error_code?: WSErrorCode;
  error_message?: string;
}

/** agent_added -- hot-reload a new agent into a running container. */
export interface AgentAddedMsg {
  agent: AgentInitConfig;
}

/** escalation_response -- supervisor's response flowing back down. */
export interface EscalationResponseMsg {
  correlation_id: string;
  task_id: string;
  agent_aid: string;
  source_team: string;
  destination_team: string;
  resolution: string;
  context: Record<string, JsonValue>;
}

/** task_cancel -- cancel a specific task. */
export interface TaskCancelMsg {
  task_id: string;
  cascade: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Container-to-Root message payloads (9 types)
// ---------------------------------------------------------------------------

/** ready -- container initialization complete. */
export interface ReadyMsg {
  team_id: string;
  agent_count: number;
  protocol_version: string;
}

/** Per-agent health data in heartbeat messages. */
export interface AgentStatusInfo {
  aid: string;
  status: AgentStatus;
  detail: string;
  elapsed_seconds: number;
  memory_mb: number;
}

/** heartbeat -- periodic health report. */
export interface HeartbeatMsg {
  team_id: string;
  agents: AgentStatusInfo[];
}

/** task_result -- task completion report. */
export interface TaskResultMsg {
  task_id: string;
  agent_aid: string;
  status: 'completed' | 'failed';
  result?: string;
  error?: string;
  files_created?: string[];
  duration: number;
}

/** escalation -- task escalation flowing upward. */
export interface EscalationMsg {
  correlation_id: string;
  task_id: string;
  agent_aid: string;
  source_team: string;
  destination_team: string;
  escalation_level: number;
  reason: EscalationReason;
  context: Record<string, JsonValue>;
}

/** log_event -- structured log transport from non-root containers. */
export interface LogEventMsg {
  level: 'debug' | 'info' | 'warn' | 'error';
  source_aid: string;
  message: string;
  metadata: Record<string, JsonValue>;
  timestamp: string;
}

/** tool_call -- SDK tool invocation forwarded to root. */
export interface ToolCallMsg {
  call_id: string;
  tool_name: string;
  arguments: JsonValue;
  agent_aid: string;
}

/** status_update -- agent status change notification. */
export interface StatusUpdateMsg {
  agent_aid: string;
  status: AgentStatus;
  detail?: string;
}

/** agent_ready -- hot-reload acknowledgment. */
export interface AgentReadyMsg {
  aid: string;
}

/** org_chart_update -- org chart change report. */
export interface OrgChartUpdateMsg {
  action: OrgChartAction;
  team_slug: string;
  agent_aid?: string;
  agent_name?: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Message type discriminators
// ---------------------------------------------------------------------------

export const RootToContainerType = {
  ContainerInit: 'container_init',
  TaskDispatch: 'task_dispatch',
  Shutdown: 'shutdown',
  ToolResult: 'tool_result',
  AgentAdded: 'agent_added',
  EscalationResponse: 'escalation_response',
  TaskCancel: 'task_cancel',
} as const;

export type RootToContainerType = (typeof RootToContainerType)[keyof typeof RootToContainerType];

export const ContainerToRootType = {
  Ready: 'ready',
  Heartbeat: 'heartbeat',
  TaskResult: 'task_result',
  Escalation: 'escalation',
  LogEvent: 'log_event',
  ToolCall: 'tool_call',
  StatusUpdate: 'status_update',
  AgentReady: 'agent_ready',
  OrgChartUpdate: 'org_chart_update',
} as const;

export type ContainerToRootType = (typeof ContainerToRootType)[keyof typeof ContainerToRootType];

// ---------------------------------------------------------------------------
// Discriminated union types
// ---------------------------------------------------------------------------

export type RootToContainerMessage =
  | { type: 'container_init'; data: ContainerInitMsg }
  | { type: 'task_dispatch'; data: TaskDispatchMsg }
  | { type: 'shutdown'; data: ShutdownMsg }
  | { type: 'tool_result'; data: ToolResultMsg }
  | { type: 'agent_added'; data: AgentAddedMsg }
  | { type: 'escalation_response'; data: EscalationResponseMsg }
  | { type: 'task_cancel'; data: TaskCancelMsg };

export type ContainerToRootMessage =
  | { type: 'ready'; data: ReadyMsg }
  | { type: 'heartbeat'; data: HeartbeatMsg }
  | { type: 'task_result'; data: TaskResultMsg }
  | { type: 'escalation'; data: EscalationMsg }
  | { type: 'log_event'; data: LogEventMsg }
  | { type: 'tool_call'; data: ToolCallMsg }
  | { type: 'status_update'; data: StatusUpdateMsg }
  | { type: 'agent_ready'; data: AgentReadyMsg }
  | { type: 'org_chart_update'; data: OrgChartUpdateMsg };

export type WSMessage = RootToContainerMessage | ContainerToRootMessage;

// ---------------------------------------------------------------------------
// All message type strings (for direction validation)
// ---------------------------------------------------------------------------

const ROOT_TO_CONTAINER_TYPES: ReadonlySet<string> = new Set<string>(
  Object.values(RootToContainerType)
);

const CONTAINER_TO_ROOT_TYPES: ReadonlySet<string> = new Set<string>(
  Object.values(ContainerToRootType)
);

// ---------------------------------------------------------------------------
// Wire format conversion
// ---------------------------------------------------------------------------

/**
 * Converts an internal WSMessage to wire format (JSON string).
 * Protocol-level fields use snake_case. Nested domain types (AgentInitConfig,
 * ResolvedProvider) retain camelCase from domain/interfaces.ts — wire-specific
 * snake_case conversion for nested payloads is deferred to L4.
 */
export function toWireFormat(message: WSMessage): string {
  return JSON.stringify({ type: message.type, data: message.data });
}

/**
 * Parses a raw wire-format JSON string into a typed WSMessage.
 * Validates the message structure, type discriminator, and payload schema.
 * This is the PRIMARY TRUST BOUNDARY for all inter-container communication.
 * Throws on invalid JSON, unknown message type, schema violation, or size limit exceeded.
 * AC-L4-08: Per-message-type payload validation.
 */
export function parseMessage(raw: string): WSMessage {
  // 1MB check BEFORE JSON.parse to prevent memory exhaustion attacks
  if (Buffer.byteLength(raw, 'utf8') > 1_048_576) {
    throw new ValidationError('Message exceeds maximum size');
  }

  // Parse JSON - throw sanitized error, never echo raw input
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationError('Invalid JSON message');
  }

  // Validate shape: must be a non-null object (not array, not primitive)
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new ValidationError('Message must be a non-null object');
  }

  const message = parsed as Record<string, unknown>;

  // Validate 'type' field exists and is a string
  if (typeof message.type !== 'string') {
    throw new ValidationError('Message type must be a string');
  }

  // Validate type is in whitelist
  if (
    !ROOT_TO_CONTAINER_TYPES.has(message.type) &&
    !CONTAINER_TO_ROOT_TYPES.has(message.type)
  ) {
    throw new ValidationError('Unknown message type');
  }

  // Validate 'data' field exists and is a non-null object
  if (
    typeof message.data !== 'object' ||
    message.data === null ||
    Array.isArray(message.data)
  ) {
    throw new ValidationError('Message data must be a non-null object');
  }

  // AC-L4-08: Validate payload against per-message-type schema
  const schema = MESSAGE_SCHEMAS[message.type];
  if (schema) {
    const result = schema.safeParse(message.data);
    if (!result.success) {
      throw new ValidationError(`Invalid ${message.type} payload: ${result.error.issues[0]?.message || 'validation failed'}`);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { type: message.type, data: message.data } as WSMessage;
}

/**
 * AC-L4-08: Extended parse with optional payload schema validation.
 * This combines structural parsing with payload validation in a single call.
 * Use this when you want all validation in one place.
 */
export function parseMessageWithValidation(
  raw: string,
  schemaValidator?: (message: WSMessage) => void,
): WSMessage {
  const message = parseMessage(raw);
  if (schemaValidator) {
    schemaValidator(message);
  }
  return message;
}

// ---------------------------------------------------------------------------
// Direction enforcement
// ---------------------------------------------------------------------------

/**
 * Validates that a message type flows in the expected direction.
 *
 * @param messageType - The message type string (e.g., 'container_init').
 * @param direction - Expected direction: 'root_to_container' or 'container_to_root'.
 * @returns true if the message type matches the expected direction.
 * @throws Error if the message type is unknown.
 */
export function validateDirection(
  messageType: string,
  direction: 'root_to_container' | 'container_to_root'
): boolean {
  const types = direction === 'root_to_container'
    ? ROOT_TO_CONTAINER_TYPES
    : CONTAINER_TO_ROOT_TYPES;
  if (!ROOT_TO_CONTAINER_TYPES.has(messageType) && !CONTAINER_TO_ROOT_TYPES.has(messageType)) {
    throw new Error(`Unknown message type: "${messageType}"`);
  }
  return types.has(messageType);
}
