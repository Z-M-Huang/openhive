/**
 * Zod schemas for all MCP tool arguments.
 *
 * @module mcp/tools/schemas
 */

import { z } from 'zod';

export const SpawnContainerSchema = z.object({
  team_slug: z.string().min(1),
  image: z.string().optional(),
  env: z.record(z.string()).optional(),
});

export const StopContainerSchema = z.object({
  team_slug: z.string().min(1),
  delete_workspace: z.boolean().optional().default(false),
});

export const ListContainersSchema = z.object({});

export const CreateTeamSchema = z.object({
  slug: z.string().min(3).max(63),
  coordinator_aid: z.string().optional(),
  purpose: z.string().min(1),
});

export const CreateAgentSchema = z.object({
  name: z.string().min(1).max(63).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Agent name must be lowercase alphanumeric with hyphens'),
  description: z.string().min(1),
  team_slug: z.string().min(1),
  model: z.string().optional(),
  skills: z.array(z.string()).optional(),
  is_coordinator: z.boolean().optional(),
});

export const CreateTaskSchema = z.object({
  agent_aid: z.string().min(1),
  prompt: z.string().min(1),
  priority: z.number().int().optional(),
  blocked_by: z.array(z.string()).optional(),
  max_retries: z.number().int().min(0).optional(),
  origin_chat_jid: z.string().optional(),
});

export const DispatchSubtaskSchema = z.object({
  agent_aid: z.string().min(1),
  prompt: z.string().min(1),
  parent_task_id: z.string().min(1),
  blocked_by: z.array(z.string()).optional(),
  priority: z.number().int().optional(),
});

export const UpdateTaskStatusSchema = z.object({
  task_id: z.string().min(1),
  status: z.enum(['pending', 'active', 'completed', 'failed', 'escalated', 'cancelled']),
  result: z.string().optional(),
  error: z.string().optional(),
});

export const SendMessageSchema = z.object({
  target_aid: z.string().min(1),
  content: z.string().min(1),
  correlation_id: z.string().optional(),
});

export const EscalateSchema = z.object({
  task_id: z.string().min(1),
  reason: z.enum(['need_guidance', 'out_of_scope', 'error', 'timeout']),
  context: z.record(z.unknown()),
});

export const SaveMemorySchema = z.object({
  content: z.string().min(1),
  memory_type: z.enum(['curated', 'daily']),
});

export const RecallMemorySchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().optional(),
  since: z.string().optional(),
});

export const CreateIntegrationSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  config: z.record(z.unknown()),
});

export const TestIntegrationSchema = z.object({
  integration_id: z.string().min(1),
});

export const ActivateIntegrationSchema = z.object({
  integration_id: z.string().min(1),
});

export const InvokeIntegrationSchema = z.object({
  name: z.string().min(1),
  endpoint: z.string().min(1),
  params: z.record(z.string()).optional(),
});

export const GetCredentialSchema = z.object({
  key: z.string().min(1),
});

export const SetCredentialSchema = z.object({
  key: z.string().min(1),
  value: z.string().min(1),
  team_slug: z.string().optional(),
});

export const GetTeamSchema = z.object({
  slug: z.string().min(1),
});

export const GetTaskSchema = z.object({
  task_id: z.string().min(1),
  status: z.enum(['pending', 'active', 'completed', 'failed', 'escalated', 'cancelled']).optional(),
});

export const GetHealthSchema = z.object({
  scope: z.string().optional(),
});

export const InspectTopologySchema = z.object({
  depth: z.number().int().positive().optional(),
});

export const RegisterWebhookSchema = z.object({
  // AC-L10-10: Path must be alphanumeric with hyphens, not reserved
  path: z.string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/, 'Path must be alphanumeric with hyphens, no leading/trailing hyphens'),
  target_team: z.string().min(1),
  event_type: z.string().optional(),
});

export const RegisterTriggerSchema = z.object({
  name: z.string().min(1).max(63).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  schedule: z.string().min(1),
  target_team: z.string().min(1),
  prompt: z.string().min(1).max(2000),
  reply_to: z.string().optional(),
});

export const SearchSkillSchema = z.object({
  query: z.string().min(1).max(200),
  registry: z.string().url().optional(),
});

export const InstallSkillSchema = z.object({
  name: z.string().min(1).max(63).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  registry_url: z.string().url(),
});

export const BrowseWebSchema = z.object({
  action: z.enum(['fetch', 'screenshot', 'click', 'extract_links']),
  url: z.string().url(),
  selector: z.string().optional(),
  fill: z.record(z.string()).optional(),
  submit_selector: z.string().optional(),
  wait_for: z.string().optional(),
  extract_text: z.boolean().optional(),
  timeout_ms: z.number().int().positive().max(60000).optional(),
}).refine(d => d.action !== 'click' || d.selector || d.fill || d.submit_selector, {
  message: 'click action requires selector, fill, or submit_selector',
});

/** Maps each tool name to its Zod schema. */
export const TOOL_SCHEMAS: Record<string, z.ZodTypeAny> = {
  spawn_container: SpawnContainerSchema,
  stop_container: StopContainerSchema,
  list_containers: ListContainersSchema,
  create_team: CreateTeamSchema,
  create_agent: CreateAgentSchema,
  create_task: CreateTaskSchema,
  dispatch_subtask: DispatchSubtaskSchema,
  update_task_status: UpdateTaskStatusSchema,
  send_message: SendMessageSchema,
  escalate: EscalateSchema,
  save_memory: SaveMemorySchema,
  recall_memory: RecallMemorySchema,
  create_integration: CreateIntegrationSchema,
  test_integration: TestIntegrationSchema,
  activate_integration: ActivateIntegrationSchema,
  get_credential: GetCredentialSchema,
  set_credential: SetCredentialSchema,
  get_team: GetTeamSchema,
  get_task: GetTaskSchema,
  get_health: GetHealthSchema,
  inspect_topology: InspectTopologySchema,
  register_webhook: RegisterWebhookSchema,
  register_trigger: RegisterTriggerSchema,
  search_skill: SearchSkillSchema,
  install_skill: InstallSkillSchema,
  invoke_integration: InvokeIntegrationSchema,
  browse_web: BrowseWebSchema,
};

/** All tool names as a readonly array, matching the wire protocol names. */
export const TOOL_NAMES: ReadonlyArray<string> = Object.keys(TOOL_SCHEMAS);

/** Total number of built-in tools. */
export const TOOL_COUNT = 27;
