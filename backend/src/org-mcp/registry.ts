/**
 * Org-MCP tool registry — single source of truth for all 9 org tool definitions.
 *
 * Provides:
 * - buildToolDefs(): pure data array of tool definitions
 * - extractShape(): Zod schema → shape record for McpServer.tool()
 * - createToolInvoker(): direct tool invocation (tests + internal use)
 *
 * Both the HTTP MCP server (http-server.ts) and tests consume this registry.
 * No SDK dependency — pure data + invoke.
 */

import { z } from 'zod';
import type { OrgTree } from '../domain/org-tree.js';
import type {
  ISessionSpawner,
  ISessionManager,
  ITaskQueueStore,
  IEscalationStore,
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
import { SyncTeamTriggersInputSchema, syncTeamTriggers } from './tools/sync-team-triggers.js';

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType;
  readonly handler: (input: unknown, callerId: string) => Promise<unknown>;
}

/**
 * Runs a query against a child team's SDK session, returning its response.
 * Wired in index.ts to call handleMessage() — breaks the circular dependency.
 */
export type TeamQueryRunner = (
  query: string, team: string, callerId: string, ancestors: string[],
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
}

export interface OrgToolInvoker {
  readonly tools: ReadonlyMap<string, ToolDefinition>;
  invoke(toolName: string, input: unknown, callerId: string): Promise<unknown>;
}

/**
 * Build the tool definitions array. Pure data — no SDK dependency.
 */
export function buildToolDefs(deps: OrgMcpDeps): ToolDefinition[] {
  return [
    {
      name: 'spawn_team',
      description: 'Create a new team and spawn its session',
      inputSchema: SpawnTeamInputSchema,
      handler: (input, callerId) => spawnTeam(input as never, callerId, {
        orgTree: deps.orgTree, spawner: deps.spawner, runDir: deps.runDir,
        loadConfig: deps.loadConfig, taskQueue: deps.taskQueue,
      }),
    },
    {
      name: 'shutdown_team',
      description: 'Shut down a team, persist tasks, remove from org tree',
      inputSchema: ShutdownTeamInputSchema,
      handler: (input, callerId) => shutdownTeam(input as never, callerId, deps),
    },
    {
      name: 'delegate_task',
      description: 'Delegate a task to a child team',
      inputSchema: DelegateTaskInputSchema,
      handler: (input, callerId) => Promise.resolve(delegateTask(input as never, callerId, deps)),
    },
    {
      name: 'escalate',
      description: 'Escalate an issue to parent team',
      inputSchema: EscalateInputSchema,
      handler: (input, callerId) => Promise.resolve(escalate(input as never, callerId, deps)),
    },
    {
      name: 'send_message',
      description: 'Send a message to a parent or child team',
      inputSchema: SendMessageInputSchema,
      handler: (input, callerId) => Promise.resolve(sendMessage(input as never, callerId, deps)),
    },
    {
      name: 'get_status',
      description: 'Get status of child teams including queue depth',
      inputSchema: GetStatusInputSchema,
      handler: (input, callerId) => Promise.resolve(getStatus(input as never, callerId, deps)),
    },
    {
      name: 'list_teams',
      description: 'List child teams with descriptions, scope keywords, and status for routing decisions',
      inputSchema: ListTeamsInputSchema,
      handler: (input, callerId) => Promise.resolve(listTeams(input as never, callerId, deps)),
    },
    {
      name: 'query_team',
      description: 'Synchronously query a child team and return its response',
      inputSchema: QueryTeamInputSchema,
      handler: (input, callerId) => queryTeam(input as never, callerId, deps),
    },
    {
      name: 'sync_team_triggers',
      description: 'Read and activate triggers from a child team\'s triggers.yaml file',
      inputSchema: SyncTeamTriggersInputSchema,
      handler: (input, callerId) => {
        if (!deps.triggerEngine) return Promise.resolve({ success: false, error: 'trigger engine not available' });
        return Promise.resolve(
          syncTeamTriggers(input as never, callerId, {
            orgTree: deps.orgTree, triggerEngine: deps.triggerEngine,
            runDir: deps.runDir, log: deps.log,
          })
        );
      },
    },
  ];
}

/**
 * Extract Zod shape for McpServer.tool() — converts ZodObject to record of shapes.
 */
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

/**
 * Create a direct tool invoker. Synchronous — no SDK dependency.
 * Used by tests and any code that needs to call org tools without MCP transport.
 */
export function createToolInvoker(deps: OrgMcpDeps): OrgToolInvoker {
  const toolDefs = buildToolDefs(deps);
  const tools = new Map(toolDefs.map(d => [d.name, d] as const));
  return {
    tools,
    async invoke(toolName: string, input: unknown, callerId: string): Promise<unknown> {
      const tool = tools.get(toolName);
      if (!tool) {
        return { success: false, error: `unknown tool: ${toolName}` };
      }
      try {
        return await tool.handler(input, callerId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: `tool error: ${msg}` };
      }
    },
  };
}
