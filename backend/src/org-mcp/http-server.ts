/**
 * Org-MCP HTTP Server — stateless Streamable HTTP transport.
 *
 * Runs on localhost:3001 (internal only). Each POST /mcp creates a fresh
 * McpServer + StreamableHTTPServerTransport per request. No shared protocol
 * state — concurrent connections from multiple sdk.query() calls are safe.
 *
 * Tool handlers close over in-process state (orgTree, taskQueue, etc.)
 * via the deps parameter. callerId extracted from X-Caller-Id header.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import type { OrgTree } from '../domain/org-tree.js';
import type { ISessionSpawner, ISessionManager, ITaskQueueStore, IEscalationStore } from '../domain/interfaces.js';
import type { TeamConfig } from '../domain/types.js';
import type { MessageHandlerDeps } from '../sessions/message-handler.js';
import { SpawnTeamInputSchema, spawnTeam } from './tools/spawn-team.js';
import { ShutdownTeamInputSchema, shutdownTeam } from './tools/shutdown-team.js';
import { DelegateTaskInputSchema, delegateTask } from './tools/delegate-task.js';
import { EscalateInputSchema, escalate } from './tools/escalate.js';
import { SendMessageInputSchema, sendMessage } from './tools/send-message.js';
import { GetStatusInputSchema, getStatus } from './tools/get-status.js';
import { QueryTeamInputSchema, queryTeam } from './tools/query-team.js';
import type { SpawnTeamConfigHints } from './tools/spawn-team.js';

export interface OrgMcpHttpDeps {
  readonly orgTree: OrgTree;
  readonly spawner: ISessionSpawner;
  readonly sessionManager: ISessionManager;
  readonly taskQueue: ITaskQueueStore;
  readonly escalationStore: IEscalationStore;
  readonly runDir: string;
  readonly loadConfig: (name: string, configPath?: string, hints?: SpawnTeamConfigHints) => TeamConfig;
  readonly getTeamConfig: (teamId: string) => TeamConfig | undefined;
  readonly log: (msg: string, meta?: Record<string, unknown>) => void;
  readonly getHandlerDeps?: () => MessageHandlerDeps | null;
}

/**
 * Extract Zod shape for McpServer.tool() — converts ZodObject to record of shapes.
 */
function extractShape(schema: z.ZodType): Record<string, z.ZodType> {
  if (schema instanceof z.ZodObject) {
    return schema.shape as Record<string, z.ZodType>;
  }
  return {};
}

/**
 * Create a fresh McpServer instance with all 7 org tools, callerId baked in.
 */
function createOrgMcpInstance(deps: OrgMcpHttpDeps, callerId: string): McpServer {
  const server = new McpServer({ name: 'org', version: '1.0.0' });

  const toolDeps = {
    orgTree: deps.orgTree,
    spawner: deps.spawner,
    sessionManager: deps.sessionManager,
    taskQueue: deps.taskQueue,
    escalationStore: deps.escalationStore,
    runDir: deps.runDir,
    loadConfig: deps.loadConfig,
    getTeamConfig: deps.getTeamConfig,
    log: deps.log,
    getHandlerDeps: deps.getHandlerDeps,
  };

  server.tool('spawn_team', extractShape(SpawnTeamInputSchema), async (args) => {
    const result = await spawnTeam(args as never, callerId, {
      orgTree: toolDeps.orgTree, spawner: toolDeps.spawner,
      runDir: toolDeps.runDir, loadConfig: toolDeps.loadConfig,
      taskQueue: toolDeps.taskQueue,
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  });

  server.tool('shutdown_team', extractShape(ShutdownTeamInputSchema), async (args) => {
    const result = await shutdownTeam(args as never, callerId, toolDeps);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  });

  server.tool('delegate_task', extractShape(DelegateTaskInputSchema), (args) => {
    const result = delegateTask(args as never, callerId, toolDeps);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  });

  server.tool('escalate', extractShape(EscalateInputSchema), (args) => {
    const result = escalate(args as never, callerId, toolDeps);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  });

  server.tool('send_message', extractShape(SendMessageInputSchema), (args) => {
    const result = sendMessage(args as never, callerId, toolDeps);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  });

  server.tool('get_status', extractShape(GetStatusInputSchema), (args) => {
    const result = getStatus(args as never, callerId, toolDeps);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  });

  server.tool('query_team', extractShape(QueryTeamInputSchema), async (args) => {
    const result = await queryTeam(args as never, callerId, toolDeps);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  });

  return server;
}

/** Read the full request body as a string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/** Send a JSON-RPC error response. */
function sendJsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  const body = JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null });
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

/**
 * Start the org-MCP HTTP server on localhost.
 * Pass port=0 for OS-assigned port (useful in tests).
 * Returns the actual port and a close function.
 */
export function startOrgMcpHttpServer(
  deps: OrgMcpHttpDeps,
  port = 3001,
): Promise<{ port: number; close: () => void }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    // Only handle /mcp
    if (url !== '/mcp') {
      sendJsonRpcError(res, 404, -32000, 'Not found.');
      return;
    }

    // Only POST is allowed (stateless mode)
    if (method !== 'POST') {
      sendJsonRpcError(res, 405, -32000, 'Method not allowed.');
      return;
    }

    // Handle POST /mcp — stateless: fresh McpServer + transport per request
    void handleMcpPost(deps, req, res);
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      deps.log('Org-MCP HTTP server started', { port: actualPort, host: '127.0.0.1' });
      resolve({ port: actualPort, close: () => { server.close(); } });
    });
  });
}

async function handleMcpPost(
  deps: OrgMcpHttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const callerId = (req.headers['x-caller-id'] as string) || 'main';
  const mcpServer = createOrgMcpInstance(deps, callerId);

  try {
    const rawBody = await readBody(req);
    const parsedBody: unknown = rawBody ? JSON.parse(rawBody) : undefined;

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, parsedBody);

    res.on('close', () => {
      void transport.close();
      void mcpServer.close();
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    deps.log('Org-MCP HTTP error', { error: msg });
    if (!res.headersSent) {
      sendJsonRpcError(res, 500, -32603, 'Internal server error');
    }
  }
}
