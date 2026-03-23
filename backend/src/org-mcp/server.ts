/**
 * Org MCP server factory — registers 6 tools with typed schemas and handlers.
 *
 * Each tool has: name, description, Zod input schema, handler function.
 * All handlers are wrapped in try-catch (R-1: must not crash the server).
 */

import type { z } from 'zod';
import type { OrgTree } from '../domain/org-tree.js';
import type {
  ISessionSpawner,
  ISessionManager,
  ITaskQueueStore,
  IEscalationStore,
} from '../domain/interfaces.js';
import type { TeamConfig } from '../domain/types.js';
import { SpawnTeamInputSchema, spawnTeam } from './tools/spawn-team.js';
import { ShutdownTeamInputSchema, shutdownTeam } from './tools/shutdown-team.js';
import { DelegateTaskInputSchema, delegateTask } from './tools/delegate-task.js';
import { EscalateInputSchema, escalate } from './tools/escalate.js';
import { SendMessageInputSchema, sendMessage } from './tools/send-message.js';
import { GetStatusInputSchema, getStatus } from './tools/get-status.js';

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType;
  readonly handler: (input: unknown, callerId: string) => Promise<unknown>;
}

export interface OrgMcpDeps {
  readonly orgTree: OrgTree;
  readonly spawner: ISessionSpawner;
  readonly sessionManager: ISessionManager;
  readonly taskQueue: ITaskQueueStore;
  readonly escalationStore: IEscalationStore;
  readonly runDir: string;
  readonly loadConfig: (name: string, configPath?: string) => TeamConfig;
  readonly getTeamConfig: (teamId: string) => TeamConfig | undefined;
  readonly log: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface OrgMcpServer {
  readonly tools: ReadonlyMap<string, ToolDefinition>;
  invoke(toolName: string, input: unknown, callerId: string): Promise<unknown>;
}

export function createOrgMcpServer(deps: OrgMcpDeps): OrgMcpServer {
  const tools = new Map<string, ToolDefinition>();

  tools.set('spawn_team', {
    name: 'spawn_team',
    description: 'Create a new team and spawn its session',
    inputSchema: SpawnTeamInputSchema,
    handler: (input, callerId) => spawnTeam(input as never, callerId, {
      orgTree: deps.orgTree,
      spawner: deps.spawner,
      runDir: deps.runDir,
      loadConfig: deps.loadConfig,
    }),
  });

  tools.set('shutdown_team', {
    name: 'shutdown_team',
    description: 'Shut down a team, persist tasks, remove from org tree',
    inputSchema: ShutdownTeamInputSchema,
    handler: (input, callerId) => shutdownTeam(input as never, callerId, deps),
  });

  tools.set('delegate_task', {
    name: 'delegate_task',
    description: 'Delegate a task to a child team with scope admission',
    inputSchema: DelegateTaskInputSchema,
    handler: (input, callerId) =>
      Promise.resolve(delegateTask(input as never, callerId, deps)),
  });

  tools.set('escalate', {
    name: 'escalate',
    description: 'Escalate an issue to parent team',
    inputSchema: EscalateInputSchema,
    handler: (input, callerId) =>
      Promise.resolve(escalate(input as never, callerId, deps)),
  });

  tools.set('send_message', {
    name: 'send_message',
    description: 'Send a message to a parent or child team',
    inputSchema: SendMessageInputSchema,
    handler: (input, callerId) =>
      Promise.resolve(sendMessage(input as never, callerId, deps)),
  });

  tools.set('get_status', {
    name: 'get_status',
    description: 'Get status of child teams including queue depth',
    inputSchema: GetStatusInputSchema,
    handler: (input, callerId) =>
      Promise.resolve(getStatus(input as never, callerId, deps)),
  });

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
        // R-1: must not crash the server
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: `tool error: ${msg}` };
      }
    },
  };
}
