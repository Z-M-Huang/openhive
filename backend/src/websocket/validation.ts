/**
 * Per-message-type Zod validation schemas for WebSocket messages (RISK-27 mitigation).
 *
 * @module websocket/validation
 */

import { z } from 'zod';
import type { WSMessage } from '../domain/interfaces.js';
import { ValidationError } from '../domain/errors.js';

// ---------------------------------------------------------------------------
// Shared sub-schemas
// ---------------------------------------------------------------------------

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

const resolvedProviderSchema = z.object({
  type: z.string(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  oauthToken: z.string().optional(),
  models: z.record(z.string()),
});

const agentInitConfigSchema = z.object({
  aid: z.string(),
  name: z.string(),
  description: z.string(),
  role: z.string(),
  model: z.string(),
  tools: z.array(z.string()),
  provider: resolvedProviderSchema,
  systemPrompt: z.string().optional(),
});

const mcpServerConfigSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string()),
});

// ---------------------------------------------------------------------------
// Root-to-Container schemas
// ---------------------------------------------------------------------------

const containerInitSchema = z.object({
  protocol_version: z.string(),
  is_main_assistant: z.boolean(),
  team_config: jsonValueSchema,
  agents: z.array(agentInitConfigSchema),
  secrets: z.record(z.string()).optional(),
  mcp_servers: z.array(mcpServerConfigSchema).optional(),
  session_token: z.string().optional(),
});

const taskDispatchSchema = z.object({
  task_id: z.string(),
  agent_aid: z.string(),
  prompt: z.string(),
  session_id: z.string().optional(),
  work_dir: z.string().optional(),
  blocked_by: z.array(z.string()),
});

const shutdownSchema = z.object({
  reason: z.string(),
  timeout: z.number(),
});

const toolResultSchema = z.object({
  call_id: z.string(),
  result: jsonValueSchema.optional(),
  error_code: z.string().optional(),
  error_message: z.string().optional(),
});

const agentAddedSchema = z.object({
  agent: agentInitConfigSchema,
});

const escalationResponseSchema = z.object({
  correlation_id: z.string(),
  task_id: z.string(),
  agent_aid: z.string(),
  source_team: z.string(),
  destination_team: z.string(),
  resolution: z.string(),
  context: z.record(jsonValueSchema),
});

const taskCancelSchema = z.object({
  task_id: z.string(),
  cascade: z.boolean(),
  reason: z.string().optional(),
});

const agentMessageSchema = z.object({
  correlation_id: z.string(),
  source_aid: z.string(),
  target_aid: z.string(),
  content: z.string().max(100000),
});

// ---------------------------------------------------------------------------
// Container-to-Root schemas
// ---------------------------------------------------------------------------

const readySchema = z.object({
  team_id: z.string(),
  agent_count: z.number(),
  protocol_version: z.string(),
});

const agentStatusInfoSchema = z.object({
  aid: z.string(),
  status: z.string(),
  detail: z.string(),
  elapsed_seconds: z.number(),
  memory_mb: z.number(),
});

const heartbeatSchema = z.object({
  team_id: z.string(),
  agents: z.array(agentStatusInfoSchema),
});

const taskResultMsgSchema = z.object({
  task_id: z.string(),
  agent_aid: z.string(),
  status: z.enum(['completed', 'failed', 'pending']),
  result: z.string().optional(),
  error: z.string().optional(),
  files_created: z.array(z.string()).optional(),
  duration: z.number(),
});

const escalationMsgSchema = z.object({
  correlation_id: z.string(),
  task_id: z.string(),
  agent_aid: z.string(),
  source_team: z.string(),
  destination_team: z.string(),
  escalation_level: z.number(),
  reason: z.string(),
  context: z.record(jsonValueSchema),
});

const logEventSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']),
  source_aid: z.string(),
  message: z.string(),
  metadata: z.record(jsonValueSchema),
  timestamp: z.string(),
});

const toolCallSchema = z.object({
  call_id: z.string(),
  tool_name: z.string(),
  arguments: jsonValueSchema,
  agent_aid: z.string(),
});

const statusUpdateSchema = z.object({
  agent_aid: z.string(),
  status: z.string(),
  detail: z.string().optional(),
});

const agentReadySchema = z.object({
  aid: z.string(),
});

const orgChartUpdateSchema = z.object({
  action: z.string(),
  team_slug: z.string(),
  agent_aid: z.string().optional(),
  agent_name: z.string().optional(),
  timestamp: z.string(),
});

// ---------------------------------------------------------------------------
// Schema map and validation function
// ---------------------------------------------------------------------------

/** Map of message type -> Zod schema for per-payload validation. */
const MESSAGE_SCHEMAS: Record<string, z.ZodType<unknown>> = {
  container_init: containerInitSchema,
  task_dispatch: taskDispatchSchema,
  shutdown: shutdownSchema,
  tool_result: toolResultSchema,
  agent_added: agentAddedSchema,
  escalation_response: escalationResponseSchema,
  task_cancel: taskCancelSchema,
  agent_message: agentMessageSchema,
  ready: readySchema,
  heartbeat: heartbeatSchema,
  task_result: taskResultMsgSchema,
  escalation: escalationMsgSchema,
  log_event: logEventSchema,
  tool_call: toolCallSchema,
  status_update: statusUpdateSchema,
  agent_ready: agentReadySchema,
  org_chart_update: orgChartUpdateSchema,
};

/**
 * Validates a parsed WSMessage's data payload against its per-type Zod schema.
 * Throws ValidationError if the payload does not match the expected shape.
 */
export function validateMessagePayload(message: WSMessage): void {
  const schema = MESSAGE_SCHEMAS[message.type];
  if (!schema) {
    throw new ValidationError(`No schema for message type: ${message.type}`);
  }
  const result = schema.safeParse(message.data);
  if (!result.success) {
    throw new ValidationError(
      `Invalid ${message.type} payload: ${result.error.issues.map((i) => i.message).join(', ')}`,
    );
  }
}
