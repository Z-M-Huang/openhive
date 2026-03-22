/**
 * WebSocket protocol type definitions, Zod schemas, and direction validation sets.
 *
 * Defines all 17 message types from WebSocket-Protocol.md:
 *   8 root-to-container: container_init, task_dispatch, shutdown, tool_result,
 *                        agent_added, escalation_response, task_cancel, agent_message
 *   9 container-to-root: ready, heartbeat, task_result, escalation, log_event,
 *                        tool_call, status_update, agent_ready, org_chart_update
 *
 * @module websocket/protocol-types
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

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
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

export const AgentMessageSchema = z.object({
  correlation_id: z.string().min(1),
  source_aid: z.string().min(1),
  target_aid: z.string().min(1),
  content: z.string().max(100000),
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
  status: z.enum(['completed', 'failed', 'pending']),
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
export const MESSAGE_SCHEMAS: Record<string, z.ZodType> = {
  container_init: ContainerInitSchema,
  task_dispatch: TaskDispatchSchema,
  shutdown: ShutdownSchema,
  tool_result: ToolResultSchema,
  agent_added: AgentAddedSchema,
  escalation_response: EscalationResponseSchema,
  agent_message: AgentMessageSchema,
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
// Root-to-Container message payloads (8 types)
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

/** agent_message -- inter-agent message routed through root. */
export interface AgentMessageMsg {
  correlation_id: string;
  source_aid: string;
  target_aid: string;
  content: string;
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
  AgentMessage: 'agent_message',
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
  | { type: 'task_cancel'; data: TaskCancelMsg }
  | { type: 'agent_message'; data: AgentMessageMsg };

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

export const ROOT_TO_CONTAINER_TYPES: ReadonlySet<string> = new Set<string>(
  Object.values(RootToContainerType)
);

export const CONTAINER_TO_ROOT_TYPES: ReadonlySet<string> = new Set<string>(
  Object.values(ContainerToRootType)
);
