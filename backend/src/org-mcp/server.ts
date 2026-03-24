/**
 * Org MCP server factory — registers 7 tools with the Claude Agent SDK.
 *
 * Uses sdk.createSdkMcpServer() + sdk.tool() to produce an injectable
 * MCP server instance for sdk.query(). Each tool handler is wrapped in
 * try-catch (R-1: must not crash the server).
 *
 * The sdkServer field is the full McpSdkServerConfigWithInstance returned
 * by createSdkMcpServer(), suitable for passing to sdk.query({ mcpServers }).
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
import type { MessageHandlerDeps } from '../sessions/message-handler.js';
import { SpawnTeamInputSchema, spawnTeam } from './tools/spawn-team.js';
import { ShutdownTeamInputSchema, shutdownTeam } from './tools/shutdown-team.js';
import { DelegateTaskInputSchema, delegateTask } from './tools/delegate-task.js';
import { EscalateInputSchema, escalate } from './tools/escalate.js';
import { SendMessageInputSchema, sendMessage } from './tools/send-message.js';
import { GetStatusInputSchema, getStatus } from './tools/get-status.js';
import { QueryTeamInputSchema, queryTeam } from './tools/query-team.js';

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
  readonly loadConfig: (name: string, configPath?: string, hints?: { description?: string; scopeAccepts?: string[]; scopeRejects?: string[] }) => TeamConfig;
  readonly getTeamConfig: (teamId: string) => TeamConfig | undefined;
  readonly log: (msg: string, meta?: Record<string, unknown>) => void;
  readonly getHandlerDeps?: () => MessageHandlerDeps | null;
}

export interface OrgMcpServer {
  readonly sdkServer: unknown; // McpSdkServerConfigWithInstance — typed as unknown to avoid import
  readonly tools: ReadonlyMap<string, ToolDefinition>;
  /** Create a team-scoped SDK MCP server with correct callerId. */
  createTeamSdkServer(teamName: string): unknown;
  invoke(toolName: string, input: unknown, callerId: string): Promise<unknown>;
}

/**
 * Build the tool definitions array. Pure data — no SDK dependency.
 */
function buildToolDefs(deps: OrgMcpDeps): ToolDefinition[] {
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
      description: 'Delegate a task to a child team with scope admission',
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
      name: 'query_team',
      description: 'Synchronously query a child team and return its response',
      inputSchema: QueryTeamInputSchema,
      handler: (input, callerId) => queryTeam(input as never, callerId, deps),
    },
  ];
}

/**
 * Extract Zod shape for sdk.tool() — same pattern as v2.
 */
function extractShape(schema: z.ZodType): Record<string, z.ZodType> {
  if (schema instanceof z.ZodObject) {
    return schema.shape as Record<string, z.ZodType>;
  }
  return {};
}

/**
 * Create the org MCP server. Async because of dynamic SDK import.
 *
 * Returns { sdkServer, tools, invoke }:
 * - sdkServer: full McpSdkServerConfigWithInstance for sdk.query({ mcpServers })
 * - tools: backward-compat Map for tests
 * - invoke(): direct invocation path for tests and internal use
 */
export async function createOrgMcpServer(deps: OrgMcpDeps): Promise<OrgMcpServer> {
  const toolDefs = buildToolDefs(deps);
  const tools = new Map<string, ToolDefinition>();
  for (const def of toolDefs) {
    tools.set(def.name, def);
  }

  // Build SDK MCP server — may fail in test env (no SDK installed)
  // Use Record to avoid type mismatch between local (no SDK) and Docker (with SDK).
  let sdkModule: Record<string, unknown> | null = null;
  let sdkServer: unknown = null;

  /** Build an SDK MCP server with the given callerId baked in. */
  function buildSdkServer(sdk: Record<string, unknown>, callerId: string): unknown {
    const sdkTool = sdk['tool'] as (...args: unknown[]) => unknown;
    const sdkCreateServer = sdk['createSdkMcpServer'] as (...args: unknown[]) => unknown;
    const sdkTools = toolDefs.map((def) =>
      sdkTool(
        def.name,
        def.description,
        extractShape(def.inputSchema),
        async (args: unknown) => {
          try {
            const result = await def.handler(args, callerId);
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: `tool error: ${msg}` }) }] };
          }
        },
      ),
    );
    return sdkCreateServer({ name: 'org', tools: sdkTools });
  }

  try {
    sdkModule = await import('@anthropic-ai/claude-agent-sdk');
    sdkServer = buildSdkServer(sdkModule, 'main');
  } catch (err) {
    // SDK not available (test env) — sdkServer stays null, invoke() still works
    const errMsg = err instanceof Error ? err.message : String(err);
    deps.log('SDK MCP server initialization failed — org tools unavailable via SDK path', { error: errMsg });
  }

  // Cache team-scoped SDK servers — each team gets exactly one instance to avoid
  // "Already connected to a transport" errors from the SDK protocol layer.
  const teamSdkServers = new Map<string, unknown>();

  return {
    sdkServer,
    tools,
    createTeamSdkServer(teamName: string): unknown {
      if (!sdkModule) return null;
      let server = teamSdkServers.get(teamName);
      if (!server) {
        server = buildSdkServer(sdkModule, teamName);
        teamSdkServers.set(teamName, server);
      }
      return server;
    },
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
