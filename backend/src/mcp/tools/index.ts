/**
 * MCP tools index — SDKToolHandler, ToolContext, and all 22 built-in tool handlers.
 *
 * Each handler is a function: (args, agentAid, teamSlug) => Promise<unknown>
 * created via `createToolHandlers(ctx)` factory. The SDKToolHandler wraps
 * handlers with authorization, validation, error mapping, and logging.
 *
 * ## Tool Catalog (10 categories, 22 tools)
 *
 * | Category       | Count | Tools                                                            |
 * |----------------|-------|------------------------------------------------------------------|
 * | Container      | 3     | spawn_container, stop_container, list_containers                 |
 * | Team           | 2     | create_team, create_agent                                        |
 * | Task           | 3     | create_task, dispatch_subtask, update_task_status                |
 * | Messaging      | 1     | send_message                                                     |
 * | Orchestration  | 1     | escalate                                                         |
 * | Memory         | 2     | save_memory, recall_memory                                       |
 * | Integration    | 3     | create_integration, test_integration, activate_integration       |
 * | Secret Mgmt    | 2     | get_credential, set_credential                                   |
 * | Query          | 4     | get_team, get_task, get_health, inspect_topology                 |
 * | Event          | 1     | register_webhook                                                 |
 *
 * @module mcp/tools
 */

import crypto from 'node:crypto';
import { z } from 'zod';

import type {
  OrgChart,
  TaskStore,
  MessageStore,
  LogStore,
  MemoryStore,
  IntegrationStore,
  CredentialStore,
  ToolCallStore,
  ContainerManager,
  ContainerProvisioner,
  KeyManager,
  WSHub,
  EventBus,
  TriggerScheduler,
  MCPRegistry,
  HealthMonitor,
  Logger,
} from '../../domain/index.js';

import {
  TaskStatus,
  IntegrationStatus,
  AgentStatus,
  ContainerHealth,
  WSErrorCode,
} from '../../domain/index.js';

import type { AgentRole } from '../../domain/index.js';

import {
  assertValidTransition,
  validateSlug,
  validateAID,
} from '../../domain/domain.js';

import {
  DomainError,
  NotFoundError,
  ValidationError,
  AccessDeniedError,
  mapDomainErrorToWSError,
} from '../../domain/errors.js';

// ---------------------------------------------------------------------------
// Secrets template resolution (AC-L6-11)
// ---------------------------------------------------------------------------

const SECRETS_TEMPLATE_REGEX = /\{secrets\.([A-Za-z0-9_]+)\}/g;

/**
 * Resolves `{secrets.XXX}` template patterns in a string.
 * Replaces each pattern with the corresponding value from the secrets object.
 * AC-L6-11: Template resolution for container_init and MCP server env.
 *
 * @param value - The string containing `{secrets.XXX}` patterns
 * @param secrets - The secrets object mapping keys to values
 * @returns The resolved string with all patterns replaced
 */
export function resolveSecretsTemplate(value: string, secrets: Record<string, string>): string {
  return value.replace(SECRETS_TEMPLATE_REGEX, (_match, key: string) => {
    if (secrets[key] !== undefined) {
      return secrets[key];
    }
    // Return original pattern if secret not found (allows graceful degradation)
    return `{secrets.${key}}`;
  });
}

/**
 * Recursively resolves `{secrets.XXX}` templates in an object.
 * Walks through all string values and replaces templates.
 */
export function resolveSecretsTemplatesInObject<T>(obj: T, secrets: Record<string, string>): T {
  if (typeof obj === 'string') {
    return resolveSecretsTemplate(obj, secrets) as T;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => resolveSecretsTemplatesInObject(item, secrets)) as T;
  }
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveSecretsTemplatesInObject(value, secrets);
    }
    return result as T;
  }
  return obj;
}

// ---------------------------------------------------------------------------
// ToolContext — dependency injection for all handlers
// ---------------------------------------------------------------------------

/** Pending memory write for retry on reconnection (AC-L6-07). */
export interface PendingMemoryWrite {
  id: number;
  agent_aid: string;
  team_slug: string;
  content: string;
  memory_type: 'curated' | 'daily';
  created_at: number;
  deleted_at: number | null;
  retries: number;
  lastError: string;
}

/** Dependency bag injected into every tool handler via the factory. */
export interface ToolContext {
  orgChart: OrgChart;
  taskStore: TaskStore;
  messageStore: MessageStore;
  logStore: LogStore;
  memoryStore: MemoryStore;
  integrationStore: IntegrationStore;
  credentialStore: CredentialStore;
  toolCallStore: ToolCallStore;
  containerManager: ContainerManager;
  provisioner: ContainerProvisioner;
  keyManager: KeyManager;
  wsHub: WSHub;
  eventBus: EventBus;
  triggerScheduler: TriggerScheduler;
  mcpRegistry: MCPRegistry;
  healthMonitor: HealthMonitor;
  logger: Logger;
  /** Memory file writer for dual-write (AC-L6-06). Writes to workspace memory file. */
  memoryFileWriter?: (agentAid: string, teamSlug: string, entry: {
    id: number;
    content: string;
    memory_type: 'curated' | 'daily';
    created_at: number;
  }) => Promise<void>;
  /** Pending memory writes queue for retry on reconnection (AC-L6-07). */
  pendingMemoryWrites?: PendingMemoryWrite[];
}

// ---------------------------------------------------------------------------
// Handler type
// ---------------------------------------------------------------------------

/** Generic tool handler signature. */
export type ToolHandler = (
  args: Record<string, unknown>,
  agentAid: string,
  teamSlug: string,
) => Promise<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Per-tool Zod schemas
// ---------------------------------------------------------------------------

const SpawnContainerSchema = z.object({
  team_slug: z.string().min(1),
  image: z.string().optional(),
  env: z.record(z.string()).optional(),
});

const StopContainerSchema = z.object({
  team_slug: z.string().min(1),
});

const ListContainersSchema = z.object({});

const CreateTeamSchema = z.object({
  slug: z.string().min(3).max(63),
  leader_aid: z.string().min(1),
  purpose: z.string().min(1),
});

const CreateAgentSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  team_slug: z.string().min(1),
  model: z.string().optional(),
  skills: z.array(z.string()).optional(),
});

const CreateTaskSchema = z.object({
  agent_aid: z.string().min(1),
  prompt: z.string().min(1),
  priority: z.number().int().optional(),
  blocked_by: z.array(z.string()).optional(),
  max_retries: z.number().int().min(0).optional(),
});

const DispatchSubtaskSchema = z.object({
  agent_aid: z.string().min(1),
  prompt: z.string().min(1),
  parent_task_id: z.string().min(1),
  blocked_by: z.array(z.string()).optional(),
  priority: z.number().int().optional(),
});

const UpdateTaskStatusSchema = z.object({
  task_id: z.string().min(1),
  status: z.enum(['pending', 'active', 'completed', 'failed', 'escalated', 'cancelled']),
  result: z.string().optional(),
  error: z.string().optional(),
});

const SendMessageSchema = z.object({
  target_aid: z.string().min(1),
  content: z.string().min(1),
  correlation_id: z.string().optional(),
});

const EscalateSchema = z.object({
  task_id: z.string().min(1),
  reason: z.enum(['need_guidance', 'out_of_scope', 'error', 'timeout']),
  context: z.record(z.unknown()),
});

const SaveMemorySchema = z.object({
  content: z.string().min(1),
  memory_type: z.enum(['curated', 'daily']),
});

const RecallMemorySchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().optional(),
  since: z.string().optional(),
});

const CreateIntegrationSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  config: z.record(z.unknown()),
});

const TestIntegrationSchema = z.object({
  integration_id: z.string().min(1),
});

const ActivateIntegrationSchema = z.object({
  integration_id: z.string().min(1),
});

const GetCredentialSchema = z.object({
  key: z.string().min(1),
});

const SetCredentialSchema = z.object({
  key: z.string().min(1),
  value: z.string().min(1),
  scope: z.string().optional(),
});

const GetTeamSchema = z.object({
  slug: z.string().min(1),
});

const GetTaskSchema = z.object({
  task_id: z.string().min(1),
  status: z.enum(['pending', 'active', 'completed', 'failed', 'escalated', 'cancelled']).optional(),
});

const GetHealthSchema = z.object({
  scope: z.string().optional(),
});

const InspectTopologySchema = z.object({
  depth: z.number().int().positive().optional(),
});

const RegisterWebhookSchema = z.object({
  // AC-L10-10: Path must be alphanumeric with hyphens, not reserved
  path: z.string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/, 'Path must be alphanumeric with hyphens, no leading/trailing hyphens'),
  target_team: z.string().min(1),
  event_type: z.string().optional(),
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
};

// ---------------------------------------------------------------------------
// Helper: generate IDs
// ---------------------------------------------------------------------------

function generateId(prefix: string, name: string): string {
  const hex = crypto.randomBytes(4).toString('hex');
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${prefix}-${slug || 'x'}-${hex}`;
}

// ---------------------------------------------------------------------------
// createToolHandlers — factory for all 22 tool handlers
// ---------------------------------------------------------------------------

/**
 * Creates all 22 tool handler functions, closed over the provided ToolContext.
 * Returns a Map<string, ToolHandler>.
 */
export function createToolHandlers(ctx: ToolContext): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  // ---- Container tools (3) ----

  handlers.set('spawn_container', async (args) => {
    const parsed = SpawnContainerSchema.parse(args);
    const info = await ctx.containerManager.spawnTeamContainer(parsed.team_slug);
    return {
      container_id: info.id,
      connected: info.health !== ContainerHealth.Unreachable,
    };
  });

  handlers.set('stop_container', async (args) => {
    const parsed = StopContainerSchema.parse(args);
    await ctx.containerManager.stopTeamContainer(parsed.team_slug, 'Tool: stop_container');
    return {
      message: `Container for team '${parsed.team_slug}' stopped`,
      final_status: 'stopped',
    };
  });

  handlers.set('list_containers', async () => {
    const containers = await ctx.containerManager.listRunningContainers();
    return {
      containers: containers.map((c) => ({
        container_id: c.id,
        team_slug: c.teamSlug,
        health: c.health,
        created_at: c.createdAt,
      })),
    };
  });

  // ---- Team tools (2) ----

  handlers.set('create_team', async (args, agentAid) => {
    const parsed = CreateTeamSchema.parse(args);
    validateSlug(parsed.slug);
    validateAID(parsed.leader_aid);

    // INV-01: leader must already exist in the parent team (org chart will enforce)
    const leader = ctx.orgChart.getAgent(parsed.leader_aid);
    if (!leader) {
      throw new NotFoundError(`Leader agent '${parsed.leader_aid}' not found in org chart`);
    }

    const callerAgent = ctx.orgChart.getAgent(agentAid);
    const parentTeam = callerAgent ? ctx.orgChart.getTeamBySlug(callerAgent.teamSlug) : undefined;
    const parentTid = parentTeam?.tid ?? '';
    const parentDepth = parentTeam?.depth ?? 0;

    const tid = generateId('tid', parsed.slug);

    // Scaffold workspace
    const parentPath = parentTeam?.workspacePath ?? '/app/workspace';
    const workspacePath = await ctx.provisioner.scaffoldWorkspace(parentPath, parsed.slug);

    // Add team to org chart
    ctx.orgChart.addTeam({
      tid,
      slug: parsed.slug,
      leaderAid: parsed.leader_aid,
      parentTid,
      depth: parentDepth + 1,
      containerId: '',
      health: ContainerHealth.Starting,
      agentAids: [],
      workspacePath,
    });

    ctx.eventBus.publish({
      type: 'team.created',
      data: { tid, slug: parsed.slug, leader_aid: parsed.leader_aid },
      timestamp: Date.now(),
      source: agentAid,
    });

    return { slug: parsed.slug, leader_aid: parsed.leader_aid, status: 'created' };
  });

  handlers.set('create_agent', async (args) => {
    const parsed = CreateAgentSchema.parse(args);

    const team = ctx.orgChart.getTeamBySlug(parsed.team_slug);
    if (!team) {
      throw new NotFoundError(`Team '${parsed.team_slug}' not found`);
    }

    const aid = generateId('aid', parsed.name);

    // Write agent definition file
    await ctx.provisioner.writeAgentDefinition(team.workspacePath, {
      name: parsed.name,
      description: parsed.description,
      model: parsed.model,
      tools: [],
      content: parsed.description,
    });

    // Add to org chart
    ctx.orgChart.addAgent({
      aid,
      name: parsed.name,
      teamSlug: parsed.team_slug,
      role: 'member',
      status: AgentStatus.Idle,
    });

    return { aid };
  });

  // ---- Task tools (3) ----

  handlers.set('create_task', async (args, agentAid) => {
    const parsed = CreateTaskSchema.parse(args);
    validateAID(parsed.agent_aid);

    // Note: Hierarchy authorization now enforced centrally in SDKToolHandler.handle()
    // (AC-L6-04: Central authorization wrapper)

    const taskId = crypto.randomUUID();

    // Validate dependencies if provided
    if (parsed.blocked_by && parsed.blocked_by.length > 0) {
      await ctx.taskStore.validateDependencies(taskId, parsed.blocked_by);
    }

    const callerAgent = ctx.orgChart.getAgent(agentAid);

    await ctx.taskStore.create({
      id: taskId,
      parent_id: '',
      team_slug: callerAgent?.teamSlug ?? '',
      agent_aid: parsed.agent_aid,
      title: parsed.prompt.slice(0, 120),
      status: TaskStatus.Pending,
      prompt: parsed.prompt,
      result: '',
      error: '',
      blocked_by: parsed.blocked_by ?? null,
      priority: parsed.priority ?? 0,
      retry_count: 0,
      max_retries: parsed.max_retries ?? 0,
      created_at: Date.now(),
      updated_at: Date.now(),
      completed_at: null,
    });

    return { task_id: taskId };
  });

  handlers.set('dispatch_subtask', async (args, agentAid) => {
    const parsed = DispatchSubtaskSchema.parse(args);
    validateAID(parsed.agent_aid);

    // Note: Hierarchy authorization now enforced centrally in SDKToolHandler.handle()
    // (AC-L6-04: Central authorization wrapper)

    const taskId = crypto.randomUUID();

    // Validate parent exists
    await ctx.taskStore.get(parsed.parent_task_id);

    // Validate dependencies if provided
    if (parsed.blocked_by && parsed.blocked_by.length > 0) {
      await ctx.taskStore.validateDependencies(taskId, parsed.blocked_by);
    }

    const callerAgent = ctx.orgChart.getAgent(agentAid);

    await ctx.taskStore.create({
      id: taskId,
      parent_id: parsed.parent_task_id,
      team_slug: callerAgent?.teamSlug ?? '',
      agent_aid: parsed.agent_aid,
      title: parsed.prompt.slice(0, 120),
      status: TaskStatus.Pending,
      prompt: parsed.prompt,
      result: '',
      error: '',
      blocked_by: parsed.blocked_by ?? null,
      priority: parsed.priority ?? 0,
      retry_count: 0,
      max_retries: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
      completed_at: null,
    });

    // Dispatch via WebSocket to target container
    const targetAgent = ctx.orgChart.getAgent(parsed.agent_aid);
    if (targetAgent) {
      const targetTeam = ctx.orgChart.getTeamBySlug(targetAgent.teamSlug);
      if (targetTeam && targetTeam.containerId) {
        ctx.wsHub.send(targetTeam.tid, {
          type: 'task_dispatch',
          data: {
            task_id: taskId,
            agent_aid: parsed.agent_aid,
            prompt: parsed.prompt,
            parent_task_id: parsed.parent_task_id,
          },
        });
      }
    }

    return { task_id: taskId };
  });

  handlers.set('update_task_status', async (args) => {
    const parsed = UpdateTaskStatusSchema.parse(args);
    const task = await ctx.taskStore.get(parsed.task_id);

    // Validate state transition
    assertValidTransition(task.status, parsed.status);

    const now = Date.now();
    const isTerminal = parsed.status === TaskStatus.Completed || parsed.status === TaskStatus.Cancelled;

    await ctx.taskStore.update({
      ...task,
      status: parsed.status,
      result: parsed.result ?? task.result,
      error: parsed.error ?? task.error,
      updated_at: now,
      completed_at: isTerminal ? now : task.completed_at,
    });

    return { status: parsed.status };
  });

  // ---- Messaging tool (1) ----

  handlers.set('send_message', async (args, agentAid) => {
    const parsed = SendMessageSchema.parse(args);

    // Note: Hierarchy authorization enforced centrally in SDKToolHandler.handle()
    const targetAgent = ctx.orgChart.getAgent(parsed.target_aid);
    if (!targetAgent) {
      throw new NotFoundError(`Target agent '${parsed.target_aid}' not found`);
    }

    // Store message
    await ctx.messageStore.create({
      id: parsed.correlation_id ?? crypto.randomUUID(),
      chat_jid: `${agentAid}:${parsed.target_aid}`,
      role: 'agent',
      content: parsed.content,
      type: 'text',
      timestamp: Date.now(),
    });

    // Route via WS to target's container
    const targetTeam = ctx.orgChart.getTeamBySlug(targetAgent.teamSlug);
    if (targetTeam) {
      ctx.wsHub.send(targetTeam.tid, {
        type: 'task_dispatch',
        data: {
          target_aid: parsed.target_aid,
          source_aid: agentAid,
          content: parsed.content,
          correlation_id: parsed.correlation_id,
        },
      });
    }

    return { delivered: true };
  });

  // ---- Orchestration tool (1) ----

  handlers.set('escalate', async (args, agentAid) => {
    const parsed = EscalateSchema.parse(args);

    // Walk OrgChart upward to find supervisor
    const agent = ctx.orgChart.getAgent(agentAid);
    if (!agent) {
      throw new NotFoundError(`Agent '${agentAid}' not found`);
    }

    const team = ctx.orgChart.getTeamBySlug(agent.teamSlug);
    if (!team) {
      throw new NotFoundError(`Team '${agent.teamSlug}' not found`);
    }

    const correlationId = crypto.randomUUID();

    // Update task status to escalated
    const task = await ctx.taskStore.get(parsed.task_id);
    assertValidTransition(task.status, TaskStatus.Escalated);
    await ctx.taskStore.update({
      ...task,
      status: TaskStatus.Escalated,
      updated_at: Date.now(),
    });

    // Publish escalation event
    ctx.eventBus.publish({
      type: 'task.escalated',
      data: {
        task_id: parsed.task_id,
        agent_aid: agentAid,
        reason: parsed.reason,
        context: parsed.context,
        correlation_id: correlationId,
        leader_aid: team.leaderAid,
      },
      timestamp: Date.now(),
      source: agentAid,
    });

    return {
      message: `Escalated to '${team.leaderAid}'`,
      correlation_id: correlationId,
    };
  });

  // ---- Memory tools (2) ----

  handlers.set('save_memory', async (args, agentAid, teamSlug) => {
    const parsed = SaveMemorySchema.parse(args);

    const memoryId = Date.now();
    const createdAt = Date.now();
    const entry = {
      id: memoryId,
      content: parsed.content,
      memory_type: parsed.memory_type,
      created_at: createdAt,
    };

    // AC-L6-06: DUAL-WRITE - file FIRST (source of truth), then SQLite index
    // Workspace file is the authoritative source; SQLite is just a search index.
    // File write failure = operation failure (don't create orphaned index entries)
    if (ctx.memoryFileWriter) {
      await ctx.memoryFileWriter(agentAid, teamSlug, entry);
    }

    // AC-L6-07: Index in SQLite for fast search/recall
    // On SQLite failure, queue for retry on reconnection
    try {
      await ctx.memoryStore.save({
        id: memoryId,
        agent_aid: agentAid,
        team_slug: teamSlug,
        content: parsed.content,
        memory_type: parsed.memory_type,
        created_at: createdAt,
        deleted_at: null,
      });
    } catch (sqliteErr) {
      // Queue for retry on reconnection (non-blocking)
      if (ctx.pendingMemoryWrites) {
        ctx.pendingMemoryWrites.push({
          id: memoryId,
          agent_aid: agentAid,
          team_slug: teamSlug,
          content: parsed.content,
          memory_type: parsed.memory_type,
          created_at: createdAt,
          deleted_at: null,
          retries: 0,
          lastError: sqliteErr instanceof Error ? sqliteErr.message : String(sqliteErr),
        });
        ctx.logger.warn('SQLite index write failed, queued for retry', {
          agent_aid: agentAid,
          memory_id: memoryId,
          queue_size: ctx.pendingMemoryWrites.length,
          error: sqliteErr instanceof Error ? sqliteErr.message : String(sqliteErr),
        });
      } else {
        // No retry queue available - re-throw
        throw sqliteErr;
      }
    }

    return { memory_id: memoryId, status: 'saved' };
  });

  handlers.set('recall_memory', async (args, agentAid) => {
    const parsed = RecallMemorySchema.parse(args);

    const memories = await ctx.memoryStore.search({
      agentAid,
      query: parsed.query,
      limit: parsed.limit ?? 10,
      since: parsed.since ? new Date(parsed.since) : undefined,
    });

    return {
      memories: memories.map((m) => ({
        id: m.id,
        content: m.content,
        memory_type: m.memory_type,
        created_at: m.created_at,
      })),
    };
  });

  // ---- Integration tools (3) ----

  handlers.set('create_integration', async (args, _agentAid, teamSlug) => {
    const parsed = CreateIntegrationSchema.parse(args);

    const integrationId = crypto.randomUUID();
    const configPath = `/app/workspace/integrations/${parsed.name}.yaml`;

    await ctx.integrationStore.create({
      id: integrationId,
      team_id: teamSlug,
      name: parsed.name,
      config_path: configPath,
      status: IntegrationStatus.Proposed,
      created_at: Date.now(),
    });

    return { integration_id: integrationId, config_path: configPath };
  });

  handlers.set('test_integration', async (args) => {
    const parsed = TestIntegrationSchema.parse(args);

    const integration = await ctx.integrationStore.get(parsed.integration_id);

    if (integration.status !== IntegrationStatus.Proposed && integration.status !== IntegrationStatus.Validated) {
      throw new ValidationError(
        `Integration '${parsed.integration_id}' cannot be tested in state '${integration.status}'`
      );
    }

    await ctx.integrationStore.updateStatus(parsed.integration_id, IntegrationStatus.Tested);

    return { success: true, errors: [] };
  });

  handlers.set('activate_integration', async (args) => {
    const parsed = ActivateIntegrationSchema.parse(args);

    const integration = await ctx.integrationStore.get(parsed.integration_id);

    if (integration.status !== IntegrationStatus.Tested && integration.status !== IntegrationStatus.Approved) {
      throw new ValidationError(
        `Integration '${parsed.integration_id}' must be tested before activation (current: '${integration.status}')`
      );
    }

    await ctx.integrationStore.updateStatus(parsed.integration_id, IntegrationStatus.Active);

    return { status: IntegrationStatus.Active };
  });

  // ---- Secret management tools (2) ----

  handlers.set('get_credential', async (args, _agentAid, teamSlug) => {
    const parsed = GetCredentialSchema.parse(args);

    const creds = await ctx.credentialStore.listByTeam(teamSlug);
    const cred = creds.find((c) => c.name === parsed.key);
    if (!cred) {
      throw new NotFoundError(`Credential '${parsed.key}' not found for team '${teamSlug}'`);
    }

    const value = await ctx.keyManager.decrypt(cred.encrypted_value);
    return { value };
  });

  handlers.set('set_credential', async (args, _agentAid, teamSlug) => {
    const parsed = SetCredentialSchema.parse(args);

    const scope = parsed.scope ?? teamSlug;
    const encrypted = await ctx.keyManager.encrypt(parsed.value);

    await ctx.credentialStore.create({
      id: crypto.randomUUID(),
      name: parsed.key,
      encrypted_value: encrypted,
      team_id: scope,
      created_at: Date.now(),
    });

    return { message: `Credential '${parsed.key}' stored` };
  });

  // ---- Query tools (4) ----

  handlers.set('get_team', async (args) => {
    const parsed = GetTeamSchema.parse(args);

    const team = ctx.orgChart.getTeamBySlug(parsed.slug);
    if (!team) {
      throw new NotFoundError(`Team '${parsed.slug}' not found`);
    }

    return {
      slug: team.slug,
      tid: team.tid,
      leader_aid: team.leaderAid,
      agent_aids: team.agentAids,
      health: team.health,
    };
  });

  handlers.set('get_task', async (args) => {
    const parsed = GetTaskSchema.parse(args);

    const task = await ctx.taskStore.get(parsed.task_id);

    if (parsed.status && task.status !== parsed.status) {
      throw new NotFoundError(
        `Task '${parsed.task_id}' found but status is '${task.status}', not '${parsed.status}'`
      );
    }

    return {
      task_id: task.id,
      status: task.status,
      agent_aid: task.agent_aid,
      prompt: task.prompt,
      result: task.result,
      error: task.error,
      created_at: task.created_at,
      completed_at: task.completed_at,
    };
  });

  handlers.set('get_health', async (args) => {
    const parsed = GetHealthSchema.parse(args);

    if (parsed.scope) {
      // Scope is a team slug or agent AID
      const team = ctx.orgChart.getTeamBySlug(parsed.scope);
      if (team) {
        const health = ctx.healthMonitor.getHealth(team.tid);
        const agents = ctx.orgChart.getAgentsByTeam(parsed.scope);
        const entries = [
          { id: team.tid, type: 'container' as const, status: health, detail: `Team '${parsed.scope}'` },
          ...agents.map((a) => ({
            id: a.aid,
            type: 'agent' as const,
            status: ctx.healthMonitor.getAgentHealth(a.aid) ?? AgentStatus.Idle,
            detail: a.name,
          })),
        ];
        return { entries };
      }

      // Maybe it's an agent AID
      const agentHealth = ctx.healthMonitor.getAgentHealth(parsed.scope);
      if (agentHealth) {
        return {
          entries: [{ id: parsed.scope, type: 'agent' as const, status: agentHealth, detail: parsed.scope }],
        };
      }

      throw new NotFoundError(`Scope '${parsed.scope}' not found`);
    }

    // System-wide health
    const allHealth = ctx.healthMonitor.getAllHealth();
    const entries: Array<{ id: string; type: 'agent' | 'container'; status: AgentStatus | ContainerHealth; detail: string }> = [];

    for (const [tid, health] of allHealth) {
      const team = ctx.orgChart.getTeam(tid);
      entries.push({
        id: tid,
        type: 'container',
        status: health,
        detail: team?.slug ?? tid,
      });
    }

    return { entries };
  });

  handlers.set('inspect_topology', async (args) => {
    const parsed = InspectTopologySchema.parse(args);
    const tree = ctx.orgChart.getTopology(parsed.depth);
    return { tree };
  });

  // ---- Event tool (1) ----

  handlers.set('register_webhook', async (args, _agentAid, teamSlug) => {
    const parsed = RegisterWebhookSchema.parse(args);

    // AC-L10-10: Reject reserved paths that shadow API routes
    const reservedPrefixes = ['api', 'health', 'ws', 'hooks', 'static', 'admin'];
    if (reservedPrefixes.some(prefix => parsed.path.toLowerCase().startsWith(prefix))) {
      throw new ValidationError(`Webhook path '${parsed.path}' uses reserved prefix`);
    }

    const registrationId = crypto.randomUUID();
    const webhookUrl = `/api/v1/hooks/${parsed.path}`;

    // Register as a cron trigger placeholder (scheduler will handle webhook routing)
    // The actual HTTP endpoint registration happens in the API layer.
    ctx.eventBus.publish({
      type: 'webhook.registered',
      data: {
        registration_id: registrationId,
        path: parsed.path,
        target_team: parsed.target_team,
        event_type: parsed.event_type,
        registered_by: teamSlug,
      },
      timestamp: Date.now(),
    });

    return { webhook_url: webhookUrl, registration_id: registrationId };
  });

  return handlers;
}

// ---------------------------------------------------------------------------
// SDKToolHandler — authorization, validation, error mapping, logging
// ---------------------------------------------------------------------------

/** Result from SDKToolHandler.handle(). */
export interface SDKToolHandlerResult {
  success: boolean;
  result?: Record<string, unknown>;
  error_code?: string;
  error_message?: string;
}

/**
 * Wraps tool handlers with authorization, Zod validation, error mapping,
 * and audit logging. This is the root-side handler for incoming tool_call
 * WebSocket messages.
 */
/**
 * Tools that require hierarchy-based authorization and their target field.
 * The handler extracts the target from args and checks OrgChart.isAuthorized().
 */
const HIERARCHY_AUTH_TOOLS: Record<string, string> = {
  create_task: 'agent_aid',
  dispatch_subtask: 'agent_aid',
  send_message: 'target_aid',
  escalate: 'target_aid', // optional target
};

export class SDKToolHandler {
  private readonly handlers: Map<string, ToolHandler>;
  private readonly ctx: ToolContext;

  constructor(ctx: ToolContext) {
    this.ctx = ctx;
    this.handlers = createToolHandlers(ctx);
  }

  /**
   * Handle a tool call from an agent.
   *
   * 1. Validate authorization (OrgChart + MCPRegistry RBAC)
   * 2. Validate args via per-tool Zod schema
   * 3. Execute handler
   * 4. Map domain errors to WS error codes
   * 5. Log to ToolCallStore
   * 6. Return result or error
   */
  async handle(
    toolName: string,
    args: Record<string, unknown>,
    agentAid: string,
    callId: string,
  ): Promise<SDKToolHandlerResult> {
    const startTime = Date.now();
    const agent = this.ctx.orgChart.getAgent(agentAid);
    const teamSlug = agent?.teamSlug ?? '';
    const role = (agent?.role ?? 'member') as AgentRole;

    try {
      // 1. Authorization: Two-tier model (AC-L6-04)
      // - Role-based access (RBAC): Enforced centrally via mcpRegistry.isAllowed()
      // - Hierarchy-based access: Enforced centrally for tools with explicit targets
      if (!this.ctx.mcpRegistry.isAllowed(toolName, role)) {
        throw new AccessDeniedError(
          `Agent '${agentAid}' (role: ${role}) is not authorized to call '${toolName}'`
        );
      }

      // Central hierarchy authorization for tools with explicit targets
      const targetField = HIERARCHY_AUTH_TOOLS[toolName];
      if (targetField && args[targetField] && typeof args[targetField] === 'string') {
        const targetAid = args[targetField] as string;
        if (!this.ctx.orgChart.isAuthorized(agentAid, targetAid)) {
          throw new AccessDeniedError(
            `Agent '${agentAid}' is not authorized to perform '${toolName}' on '${targetAid}'`
          );
        }
      }

      // 2. Check handler exists
      const handler = this.handlers.get(toolName);
      if (!handler) {
        throw new NotFoundError(`Tool '${toolName}' not found`);
      }

      // 3. Validate args
      const schema = TOOL_SCHEMAS[toolName];
      if (schema) {
        schema.parse(args);
      }

      // 4. Execute handler
      const result = await handler(args, agentAid, teamSlug);

      // 5. Log success
      await this.logToolCall(callId, toolName, agentAid, teamSlug, args, JSON.stringify(result), '', Date.now() - startTime);

      return { success: true, result };
    } catch (err: unknown) {
      // Map domain errors to WS error codes
      const errorCode = err instanceof DomainError
        ? mapDomainErrorToWSError(err)
        : WSErrorCode.InternalError;

      const errorMessage = err instanceof Error ? err.message : String(err);

      // Log failure
      await this.logToolCall(callId, toolName, agentAid, teamSlug, args, '', errorMessage, Date.now() - startTime);

      return { success: false, error_code: errorCode, error_message: errorMessage };
    }
  }

  /** Convenience: get the underlying handlers map. */
  getHandlers(): Map<string, ToolHandler> {
    return this.handlers;
  }

  private async logToolCall(
    callId: string,
    toolName: string,
    agentAid: string,
    teamSlug: string,
    params: Record<string, unknown>,
    resultSummary: string,
    error: string,
    durationMs: number,
  ): Promise<void> {
    try {
      await this.ctx.toolCallStore.create({
        id: 0, // auto-assigned
        log_entry_id: 0,
        tool_use_id: callId,
        tool_name: toolName,
        agent_aid: agentAid,
        team_slug: teamSlug,
        task_id: '',
        params: JSON.stringify(params),
        result_summary: resultSummary.slice(0, 1000),
        error,
        duration_ms: durationMs,
        created_at: Date.now(),
      });
    } catch {
      // Logging failures should not propagate
      this.ctx.logger.warn('Failed to log tool call', { call_id: callId, tool_name: toolName });
    }
  }
}

// ---------------------------------------------------------------------------
// Re-exports for backward compatibility
// ---------------------------------------------------------------------------

/** All tool names as a readonly array, matching the wire protocol names. */
export const TOOL_NAMES: ReadonlyArray<string> = Object.keys(TOOL_SCHEMAS);

/** Total number of built-in tools. */
export const TOOL_COUNT = 22;
