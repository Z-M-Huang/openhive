/**
 * Org-MCP tool registry — single source of truth for all org tool definitions.
 * Both the HTTP MCP server (http-server.ts) and tests consume this registry.
 */

import { z } from 'zod';
import { errorMessage } from '../domain/errors.js';
import type { OrgTree } from '../domain/org-tree.js';
import type {
  ISessionSpawner,
  ISessionManager,
  ITaskQueueStore,
  IEscalationStore,
  ITriggerConfigStore,
} from '../domain/interfaces.js';
import type { TeamConfig } from '../domain/types.js';
import type { SpawnTeamConfigHints } from './tools/spawn-team.js';
import { SpawnTeamInputSchema, spawnTeam } from './tools/spawn-team.js';
import { ShutdownTeamInputSchema, shutdownTeam } from './tools/shutdown-team.js';
import { DelegateTaskInputSchema, delegateTask } from './tools/delegate-task.js';
import { EscalateInputSchema, escalate } from './tools/escalate.js';
import { SendMessageInputSchema, sendMessage } from './tools/send-message.js';
import { GetStatusInputSchema, getStatus } from './tools/get-status.js';
import { QueryTeamInputSchema, queryTeam } from './tools/query-team.js';
import { ListTeamsInputSchema, listTeams } from './tools/list-teams.js';
import type { TriggerEngine } from '../triggers/engine.js';
import { GetCredentialInputSchema, getCredential } from './tools/get-credential.js';
import type { BrowserRelay } from './browser-proxy.js';
import { buildBrowserToolDefs } from './browser-tools.js';
import { CreateTriggerInputSchema, createTrigger } from './tools/create-trigger.js';
import { EnableTriggerInputSchema, enableTrigger } from './tools/enable-trigger.js';
import { DisableTriggerInputSchema, disableTrigger } from './tools/disable-trigger.js';
import { TestTriggerInputSchema, testTrigger } from './tools/test-trigger.js';
import { ListTriggersInputSchema, listTriggers } from './tools/list-triggers.js';
import { UpdateTeamInputSchema, updateTeam } from './tools/update-team.js';
import { UpdateTriggerInputSchema, updateTrigger } from './tools/update-trigger.js';


/** Wraps a task queue to auto-inject sourceChannelId into options JSON.
 *  Only enqueue() is overridden; all other methods pass through via prototype. */
function scopeQueue(queue: ITaskQueueStore, channelId?: string): ITaskQueueStore {
  if (!channelId) return queue;
  const enqueue: ITaskQueueStore['enqueue'] = (teamId, task, priority, correlationId?, options?) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = options ? JSON.parse(options) as Record<string, unknown> : {};
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) parsed = {};
    } catch { parsed = {}; }
    parsed.sourceChannelId = channelId;
    return queue.enqueue(teamId, task, priority, correlationId, JSON.stringify(parsed));
  };
  return Object.assign(Object.create(queue) as ITaskQueueStore, { enqueue });
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType;
  readonly handler: (input: unknown, callerId: string, sourceChannelId?: string) => Promise<unknown>;
}

/** Runs a query against a child team's SDK session, returning its response. */
export type TeamQueryRunner = (
  query: string, team: string, callerId: string, ancestors: string[], sourceChannelId?: string,
) => Promise<string | void>;

export interface OrgMcpDeps {
  readonly orgTree: OrgTree;
  readonly spawner: ISessionSpawner;
  readonly sessionManager: ISessionManager;
  readonly taskQueue: ITaskQueueStore;
  readonly escalationStore: IEscalationStore;
  readonly runDir: string;
  readonly loadConfig: (name: string, configPath?: string, hints?: SpawnTeamConfigHints) => TeamConfig;
  readonly getTeamConfig: (teamId: string) => TeamConfig | undefined;
  readonly log: (msg: string, meta?: Record<string, unknown>) => void;
  readonly queryRunner?: TeamQueryRunner;
  readonly triggerEngine?: TriggerEngine;
  readonly triggerConfigStore?: ITriggerConfigStore;
  readonly browserRelay?: BrowserRelay;
}

/* ── Narrowed dep types — compile-time enforcement that each tool
      only receives the OrgMcpDeps fields it actually needs. ──────── */

export type ShutdownTeamOrgDeps = Pick<OrgMcpDeps, 'orgTree' | 'sessionManager' | 'taskQueue'> & {
  readonly triggerEngine?: OrgMcpDeps['triggerEngine'];
};
export type DelegateTaskOrgDeps = Pick<OrgMcpDeps, 'orgTree' | 'taskQueue' | 'log'>;
export type EscalateOrgDeps = Pick<OrgMcpDeps, 'orgTree' | 'escalationStore' | 'taskQueue'>;
export type SendMessageOrgDeps = Pick<OrgMcpDeps, 'orgTree' | 'log'>;
export type GetStatusOrgDeps = Pick<OrgMcpDeps, 'orgTree' | 'taskQueue'>;
export type ListTeamsOrgDeps = Pick<OrgMcpDeps, 'orgTree' | 'taskQueue' | 'getTeamConfig'>;
export type QueryTeamOrgDeps = Pick<OrgMcpDeps, 'orgTree' | 'getTeamConfig' | 'log'> & {
  readonly queryRunner?: OrgMcpDeps['queryRunner'];
};
export type BrowserToolOrgDeps = Pick<OrgMcpDeps, 'getTeamConfig'> & {
  readonly browserRelay: BrowserRelay;
};

export interface OrgToolInvoker {
  readonly tools: ReadonlyMap<string, ToolDefinition>;
  invoke(toolName: string, input: unknown, callerId: string, sourceChannelId?: string): Promise<unknown>;
}

/** Build the tool definitions array. Pure data — no SDK dependency. */
export function buildToolDefs(deps: OrgMcpDeps): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      name: 'spawn_team',
      description: 'Create a new team and spawn its session',
      inputSchema: SpawnTeamInputSchema,
      handler: (input, callerId, sourceChannelId) => spawnTeam(input as never, callerId, {
        orgTree: deps.orgTree, spawner: deps.spawner, runDir: deps.runDir,
        loadConfig: deps.loadConfig, taskQueue: scopeQueue(deps.taskQueue, sourceChannelId),
      }),
    },
    {
      name: 'shutdown_team',
      description: 'Shut down a team, persist tasks, remove from org tree',
      inputSchema: ShutdownTeamInputSchema,
      handler: (input, callerId) => shutdownTeam(input as never, callerId, {
        orgTree: deps.orgTree, sessionManager: deps.sessionManager,
        taskQueue: deps.taskQueue, triggerEngine: deps.triggerEngine,
      }),
    },
    {
      name: 'delegate_task',
      description: 'Delegate a task to a child team',
      inputSchema: DelegateTaskInputSchema,
      handler: (input, callerId, sourceChannelId) => Promise.resolve(
        delegateTask(input as never, callerId, {
          orgTree: deps.orgTree, taskQueue: scopeQueue(deps.taskQueue, sourceChannelId), log: deps.log,
        })
      ),
    },
    {
      name: 'escalate',
      description: 'Escalate an issue to parent team',
      inputSchema: EscalateInputSchema,
      handler: (input, callerId, sourceChannelId) => Promise.resolve(
        escalate(input as never, callerId, {
          orgTree: deps.orgTree, escalationStore: deps.escalationStore,
          taskQueue: scopeQueue(deps.taskQueue, sourceChannelId),
        })
      ),
    },
    {
      name: 'send_message',
      description: 'Send a message to a parent or child team',
      inputSchema: SendMessageInputSchema,
      handler: (input, callerId) => Promise.resolve(sendMessage(input as never, callerId, {
        orgTree: deps.orgTree, log: deps.log,
      })),
    },
    {
      name: 'get_status',
      description: 'Get status of child teams including queue depth',
      inputSchema: GetStatusInputSchema,
      handler: (input, callerId) => Promise.resolve(getStatus(input as never, callerId, {
        orgTree: deps.orgTree, taskQueue: deps.taskQueue,
      })),
    },
    {
      name: 'list_teams',
      description: 'List child teams with descriptions, scope keywords, and status for routing decisions',
      inputSchema: ListTeamsInputSchema,
      handler: (input, callerId) => Promise.resolve(listTeams(input as never, callerId, {
        orgTree: deps.orgTree, taskQueue: deps.taskQueue, getTeamConfig: deps.getTeamConfig,
      })),
    },
    {
      name: 'query_team',
      description: 'Synchronously query a child team and return its response',
      inputSchema: QueryTeamInputSchema,
      handler: (input, callerId, sourceChannelId) => queryTeam(input as never, callerId, {
        orgTree: deps.orgTree, getTeamConfig: deps.getTeamConfig,
        queryRunner: deps.queryRunner, log: deps.log,
      }, sourceChannelId),
    },
    {
      name: 'get_credential',
      description: 'Retrieve a credential value by key. Use for API calls — do NOT store returned values in files.',
      inputSchema: GetCredentialInputSchema,
      handler: (input, callerId) => Promise.resolve(
        getCredential(input as never, callerId, {
          getTeamConfig: deps.getTeamConfig, log: deps.log,
        })
      ),
    },
    {
      name: 'update_team',
      description: 'Update a child team scope keywords',
      inputSchema: UpdateTeamInputSchema,
      handler: (input, callerId) => Promise.resolve(
        updateTeam(input as never, callerId, { orgTree: deps.orgTree, log: deps.log })
      ),
    },
  ];

  // Trigger management tools (require configStore + triggerEngine)
  if (deps.triggerConfigStore) {
    const configStore = deps.triggerConfigStore;

    tools.push({
      name: 'create_trigger',
      description: 'Create a new trigger in pending state for a child team',
      inputSchema: CreateTriggerInputSchema,
      handler: (input, callerId, sourceChannelId) => Promise.resolve(
        createTrigger(input as never, callerId, {
          orgTree: deps.orgTree, configStore, log: deps.log,
        }, sourceChannelId)
      ),
    });

    tools.push({
      name: 'enable_trigger',
      description: 'Activate a pending or disabled trigger and register its handler',
      inputSchema: EnableTriggerInputSchema,
      handler: (input, callerId) => {
        if (!deps.triggerEngine) return Promise.resolve({ success: false, error: 'trigger engine not available' });
        return Promise.resolve(
          enableTrigger(input as never, callerId, {
            orgTree: deps.orgTree, configStore, triggerEngine: deps.triggerEngine, log: deps.log,
          })
        );
      },
    });

    tools.push({
      name: 'disable_trigger',
      description: 'Deactivate a trigger and unregister its handler',
      inputSchema: DisableTriggerInputSchema,
      handler: (input, callerId) => {
        if (!deps.triggerEngine) return Promise.resolve({ success: false, error: 'trigger engine not available' });
        return Promise.resolve(
          disableTrigger(input as never, callerId, {
            orgTree: deps.orgTree, configStore, triggerEngine: deps.triggerEngine, log: deps.log,
          })
        );
      },
    });

    tools.push({
      name: 'test_trigger',
      description: 'Fire a trigger once for testing without changing its state. Supports max_turns override.',
      inputSchema: TestTriggerInputSchema,
      handler: (input, callerId, sourceChannelId) => Promise.resolve(
        testTrigger(input as never, callerId, {
          orgTree: deps.orgTree, configStore, taskQueue: scopeQueue(deps.taskQueue, sourceChannelId), log: deps.log,
        })
      ),
    });

    tools.push({
      name: 'list_triggers',
      description: 'List all triggers and their states for a team',
      inputSchema: ListTriggersInputSchema,
      handler: (input, callerId) => Promise.resolve(
        listTriggers(input as never, callerId, {
          orgTree: deps.orgTree, configStore,
        })
      ),
    });

    tools.push({
      name: 'update_trigger',
      description: 'Update trigger config, task, or settings',
      inputSchema: UpdateTriggerInputSchema,
      handler: (input, callerId) => {
        if (!deps.triggerEngine) return Promise.resolve({ success: false, error: 'trigger engine not available' });
        return Promise.resolve(
          updateTrigger(input as never, callerId, {
            orgTree: deps.orgTree, configStore, triggerEngine: deps.triggerEngine, log: deps.log,
          })
        );
      },
    });

  }

  // Browser tools (require browserRelay)
  if (deps.browserRelay?.available) {
    tools.push(...buildBrowserToolDefs({
      getTeamConfig: deps.getTeamConfig, browserRelay: deps.browserRelay,
    }));
  }

  return tools;
}

/** Extract Zod shape for McpServer.tool() — converts ZodObject to record of shapes. */
export function extractShape(schema: z.ZodType): Record<string, z.ZodType> {
  if (schema instanceof z.ZodObject) {
    return schema.shape as Record<string, z.ZodType>;
  }
  // Unwrap ZodEffects (.refine(), .transform(), .superRefine())
  if (schema instanceof z.ZodEffects) {
    return extractShape(schema._def.schema as z.ZodType);
  }
  return {};
}

/** Create a direct tool invoker for tests and internal use. */
export function createToolInvoker(deps: OrgMcpDeps): OrgToolInvoker {
  const toolDefs = buildToolDefs(deps);
  const tools = new Map(toolDefs.map(d => [d.name, d] as const));
  return {
    tools,
    async invoke(toolName: string, input: unknown, callerId: string, sourceChannelId?: string): Promise<unknown> {
      const tool = tools.get(toolName);
      if (!tool) {
        return { success: false, error: `unknown tool: ${toolName}` };
      }
      try {
        return await tool.handler(input, callerId, sourceChannelId);
      } catch (err) {
        const msg = errorMessage(err);
        return { success: false, error: `tool error: ${msg}` };
      }
    },
  };
}
