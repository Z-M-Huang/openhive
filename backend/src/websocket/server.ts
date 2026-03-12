/**
 * WebSocket server for OpenHive (root-only).
 *
 * Manages the server-side WS hub using ws.WebSocketServer in noServer mode.
 * Handles HTTP upgrade requests on the /ws/container path with one-time token
 * validation during the upgrade handshake. Each connected container gets a
 * single persistent bidirectional JSON channel.
 *
 * // INV-02: All inter-container messages flow through root WS hub.
 * // Hub-and-spoke topology — no direct container-to-container communication.
 * // Root routes all messages based on the org chart.
 */

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { URL } from 'node:url';
import { z } from 'zod';
import { WebSocketServer, type WebSocket } from 'ws';
import type { WSHub, WSMessage, TokenManager } from '../domain/interfaces.js';
import { NotFoundError, ValidationError } from '../domain/errors.js';
import { parseMessage } from './protocol.js';

// ---------------------------------------------------------------------------
// Per-message-type Zod schemas (RISK-27 mitigation)
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

// Root-to-Container schemas
const containerInitSchema = z.object({
  protocol_version: z.string(),
  is_main_assistant: z.boolean(),
  team_config: jsonValueSchema,
  agents: z.array(agentInitConfigSchema),
  secrets: z.record(z.string()).optional(),
  mcp_servers: z.array(mcpServerConfigSchema).optional(),
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

// Container-to-Root schemas
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
  status: z.enum(['completed', 'failed']),
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

/** Map of message type -> Zod schema for per-payload validation. */
const MESSAGE_SCHEMAS: Record<string, z.ZodType<unknown>> = {
  container_init: containerInitSchema,
  task_dispatch: taskDispatchSchema,
  shutdown: shutdownSchema,
  tool_result: toolResultSchema,
  agent_added: agentAddedSchema,
  escalation_response: escalationResponseSchema,
  task_cancel: taskCancelSchema,
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

// ---------------------------------------------------------------------------
// WSServer callbacks
// ---------------------------------------------------------------------------

/** Callbacks for WSServer lifecycle events. */
export interface WSServerCallbacks {
  onMessage: (tid: string, message: WSMessage) => void;
  onConnect: (tid: string) => void;
  onDisconnect: (tid: string) => void;
}

// ---------------------------------------------------------------------------
// WSServer implementation
// ---------------------------------------------------------------------------

/**
 * WebSocket server implementing the WSHub interface (root-only).
 *
 * Uses ws.WebSocketServer in noServer mode — the HTTP server calls
 * {@link handleUpgrade} on the `upgrade` event. The server validates
 * the one-time token from the query string during the upgrade handshake
 * before accepting the connection.
 *
 * Upgrade path: /ws/container?token=<one-time-token>&team=<team-id>
 */
export class WSServer implements WSHub {
  private readonly _tokenManager: TokenManager;
  private readonly _callbacks: WSServerCallbacks;
  private readonly _connections: Map<string, WebSocket> = new Map();
  private _wss: WebSocketServer | undefined;

  constructor(tokenManager: TokenManager, callbacks: WSServerCallbacks) {
    this._tokenManager = tokenManager;
    this._callbacks = callbacks;
  }

  /**
   * Initializes the ws.WebSocketServer in noServer mode and sets up
   * connection/message/close event handlers. Called once during root startup.
   */
  start(): void {
    this._wss = new WebSocketServer({
      noServer: true,
      maxPayload: 1_048_576, // 1 MB inbound limit
    });
  }

  /**
   * Gracefully shuts down the WS server. Closes all active connections
   * with a 1001 (Going Away) code and drains pending messages.
   */
  async close(): Promise<void> {
    for (const [tid, ws] of this._connections) {
      ws.close(1001, 'Server shutting down');
      this._connections.delete(tid);
    }
    if (this._wss) {
      await new Promise<void>((resolve, reject) => {
        this._wss!.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      this._wss = undefined;
    }
  }

  /**
   * Handles an HTTP upgrade request for a WebSocket connection.
   *
   * Validates the upgrade path is /ws/container, extracts the one-time token
   * and TID from the query string, validates the token via TokenManager,
   * and either accepts (upgrades) or rejects (destroys socket with 401) the
   * connection.
   */
  handleUpgrade(request: unknown, socket: unknown, head: unknown): void {
    const req = request as IncomingMessage;
    const sock = socket as Duplex;
    const buf = head as Buffer;

    if (!this._wss) {
      sock.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      sock.destroy();
      return;
    }

    // Parse URL to extract query params
    const url = new URL(req.url ?? '', 'http://localhost');

    // Validate path
    if (url.pathname !== '/ws/container') {
      sock.write('HTTP/1.1 404 Not Found\r\n\r\n');
      sock.destroy();
      return;
    }

    const token = url.searchParams.get('token');
    const team = url.searchParams.get('team');

    if (!token || !team) {
      sock.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      sock.destroy();
      return;
    }

    // Validate token via TokenManager
    if (!this._tokenManager.validate(token, team)) {
      sock.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      sock.destroy();
      return;
    }

    // Token valid — upgrade the connection
    this._wss.handleUpgrade(req, sock, buf, (ws) => {
      this._registerConnection(team, ws);
    });
  }

  /**
   * Sends a typed message to a specific connected container identified by TID.
   * Serializes the message to wire format before sending.
   *
   * @throws NotFoundError if no connection exists for the given TID.
   */
  send(tid: string, message: WSMessage): void {
    const ws = this._connections.get(tid);
    if (!ws) {
      throw new NotFoundError(`No connection for TID: ${tid}`);
    }
    ws.send(JSON.stringify({ type: message.type, data: message.data }));
  }

  /**
   * Broadcasts a message to all connected containers.
   * Serializes the message to wire format and sends to every active connection.
   * Skips connections that are not in OPEN state.
   */
  broadcast(message: WSMessage): void {
    const data = JSON.stringify({ type: message.type, data: message.data });
    for (const [, ws] of this._connections) {
      if (ws.readyState === 1) {
        ws.send(data);
      }
    }
  }

  /**
   * Checks whether a container with the given TID has an active WebSocket connection.
   */
  isConnected(tid: string): boolean {
    return this._connections.has(tid);
  }

  /**
   * Returns the TIDs of all currently connected containers.
   */
  getConnectedTeams(): string[] {
    return Array.from(this._connections.keys());
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Registers a newly upgraded WebSocket connection, wiring up message
   * and close handlers.
   */
  private _registerConnection(tid: string, ws: WebSocket): void {
    // Close existing connection for this TID if any
    const existing = this._connections.get(tid);
    if (existing) {
      existing.close(1001, 'Replaced by new connection');
    }

    this._connections.set(tid, ws);
    this._callbacks.onConnect(tid);

    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      try {
        const raw = data.toString();
        const parsed = parseMessage(raw);
        // Convert protocol discriminated union to interface WSMessage
        const msg: WSMessage = { type: parsed.type, data: parsed.data as unknown as Record<string, unknown> };
        validateMessagePayload(msg);
        this._callbacks.onMessage(tid, msg);
      } catch {
        // Malformed message — close with policy violation
        ws.close(1008, 'Invalid message');
      }
    });

    ws.on('close', () => {
      this._connections.delete(tid);
      this._callbacks.onDisconnect(tid);
    });
  }
}
