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
import type { WSHub, WSMessage, WSConnection, TokenManager } from '../domain/interfaces.js';
import { ValidationError } from '../domain/errors.js';
import { parseMessage } from './protocol.js';
import { WSHubImpl } from './hub.js';

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

// ---------------------------------------------------------------------------
// WebSocket Connection Adapter
// ---------------------------------------------------------------------------

/**
 * Adapter that wraps a raw ws.WebSocket to implement the WSConnection interface.
 *
 * This allows WSHubImpl to work with WebSocket connections from the server
 * while providing the rate limiting and write queue features.
 */
class WebSocketConnectionAdapter implements WSConnection {
  readonly tid: string;
  private readonly _ws: WebSocket;
  private _lastPong: number = Date.now();

  constructor(tid: string, ws: WebSocket) {
    this.tid = tid;
    this._ws = ws;

    // Track pong responses for isAlive()
    ws.on('pong', () => {
      this._lastPong = Date.now();
    });
  }

  send(message: WSMessage): void {
    if (this._ws.readyState === 1) {
      this._ws.send(JSON.stringify({ type: message.type, data: message.data }));
    }
  }

  close(code?: number, reason?: string): void {
    if (this._ws.readyState === 1) {
      this._ws.close(code ?? 1000, reason ?? '');
    }
  }

  onMessage(handler: (message: WSMessage) => void): void {
    this._ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      try {
        const raw = data.toString();
        const parsed = parseMessage(raw);
        const msg: WSMessage = { type: parsed.type, data: parsed.data as unknown as Record<string, unknown> };
        handler(msg);
      } catch {
        // Malformed message — close with policy violation
        this._ws.close(1008, 'Invalid message');
      }
    });
  }

  onClose(handler: (code: number, reason: string) => void): void {
    this._ws.on('close', (code: number, reason: Buffer) => {
      handler(code, reason.toString());
    });
  }

  isAlive(): boolean {
    // Consider alive if we've received a pong within last 60 seconds
    // and the socket is in OPEN state
    return this._ws.readyState === 1 && (Date.now() - this._lastPong) < 60000;
  }

  /** Sends a WebSocket ping frame to the remote peer. */
  ping(): void {
    if (this._ws.readyState === 1) {
      this._ws.ping();
    }
  }

  /** Returns the timestamp (ms since epoch) when the last pong was received. */
  get lastPong(): number {
    return this._lastPong;
  }
}

// ---------------------------------------------------------------------------
// WSServer callbacks
// ---------------------------------------------------------------------------

/** Callbacks for WSServer lifecycle events. */
export interface WSServerCallbacks {
  onMessage: (tid: string, message: WSMessage) => void;
  /**
   * Called when a container establishes a WebSocket connection.
   *
   * @param tid        - Team ID of the connecting container.
   * @param isReconnect - True when authentication was via session token (reconnect),
   *                      false when authenticated via one-time token (initial connect).
   *                      Callers should skip sending container_init on reconnects because
   *                      the container already has its configuration (AC-A3).
   */
  onConnect: (tid: string, isReconnect: boolean) => void;
  onDisconnect: (tid: string) => void;
}

// ---------------------------------------------------------------------------
// WSServer implementation
// ---------------------------------------------------------------------------

/** Interval (ms) between server-side ping frames sent to each container. */
const PING_INTERVAL_MS = 30_000;

/** Deadline (ms) after which a missing pong is logged as a warning. */
const PING_DEADLINE_MS = 10_000;

/**
 * WebSocket server implementing the WSHub interface (root-only).
 *
 * Uses ws.WebSocketServer in noServer mode — the HTTP server calls
 * {@link handleUpgrade} on the `upgrade` event. The server validates
 * the one-time token from the query string during the upgrade handshake
 * before accepting the connection.
 *
 * Internally uses WSHubImpl for:
 * - Per-connection rate limiting (100 msgs/sec)
 * - Write queue management (256 msg capacity)
 * - INV-02/03 routing validation
 *
 * Upgrade path: /ws/container?token=<one-time-token>&team=<team-id>
 */

export class WSServer implements WSHub {
  private readonly _tokenManager: TokenManager;
  private readonly _callbacks: WSServerCallbacks;
  private readonly _hub: WSHubImpl;
  private readonly _adapters: Map<string, WebSocketConnectionAdapter> = new Map();
  private _wss: WebSocketServer | undefined;
  private _pingTimer: ReturnType<typeof setInterval> | undefined;

  constructor(tokenManager: TokenManager, callbacks: WSServerCallbacks) {
    this._tokenManager = tokenManager;
    this._callbacks = callbacks;
    this._hub = new WSHubImpl();
  }

  /**
   * Returns the underlying WSHubImpl for direct access to routing features.
   * Used when root needs to route messages between containers.
   */
  get hub(): WSHubImpl {
    return this._hub;
  }

  /**
   * Initializes the ws.WebSocketServer in noServer mode and sets up
   * connection/message/close event handlers. Called once during root startup.
   *
   * Also starts the 30-second ping loop (AC-A4): iterates all connected adapters,
   * sends a WebSocket ping frame to each, and schedules a 10-second deadline
   * check. If no pong has been received within the deadline, logs a warning.
   * The health monitor transitions the container state via heartbeat absence.
   */
  start(): void {
    this._wss = new WebSocketServer({
      noServer: true,
      maxPayload: 1_048_576, // 1 MB inbound limit
    });

    // Start root-side ping loop (CON-05: 30-second interval).
    this._pingTimer = setInterval(() => {
      const pingTime = Date.now();
      for (const [tid, adapter] of this._adapters) {
        adapter.ping();
        // Schedule a 10-second deadline check per adapter.
        setTimeout(() => {
          if (adapter.lastPong < pingTime) {
            // No pong received since we sent the ping — log a warning.
            // The health monitor handles state transition via heartbeat absence.
            console.warn(`[WSServer] No pong from ${tid} within ${PING_DEADLINE_MS}ms`);
          }
        }, PING_DEADLINE_MS);
      }
    }, PING_INTERVAL_MS);
  }

  /**
   * Gracefully shuts down the WS server. Closes all active connections
   * with a 1001 (Going Away) code and drains pending messages.
   */
  async close(): Promise<void> {
    // Stop the ping loop first so no new pings are sent during shutdown.
    if (this._pingTimer !== undefined) {
      clearInterval(this._pingTimer);
      this._pingTimer = undefined;
    }

    // Close the hub (drains write queues and closes all connections)
    await this._hub.close();
    this._adapters.clear();

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

    // Validate token via TokenManager.
    // Try one-time token first (initial connect), then session token (reconnect).
    const isOneTimeValid = this._tokenManager.validate(token, team);
    const isSessionValid = !isOneTimeValid && this._tokenManager.validateSession(token, team);
    if (!isOneTimeValid && !isSessionValid) {
      sock.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      sock.destroy();
      return;
    }

    // Token valid — upgrade the connection.
    // Pass isReconnect so the onConnect callback can skip container_init for
    // containers that are reconnecting with an existing session (AC-A3).
    this._wss.handleUpgrade(req, sock, buf, (ws) => {
      this._registerConnection(team, ws, isSessionValid);
    });
  }

  /**
   * Sends a typed message to a specific connected container identified by TID.
   * Delegates to WSHubImpl which provides rate limiting and write queue management.
   *
   * @throws NotFoundError if no connection exists for the given TID.
   * @throws RateLimitedError if the rate limit has been exceeded for this connection.
   */
  send(tid: string, message: WSMessage): void {
    this._hub.send(tid, message);
  }

  /**
   * Broadcasts a message to all connected containers.
   * Delegates to WSHubImpl which enqueues messages in per-connection write queues.
   */
  broadcast(message: WSMessage): void {
    this._hub.broadcast(message);
  }

  /**
   * Checks whether a container with the given TID has an active WebSocket connection.
   */
  isConnected(tid: string): boolean {
    return this._hub.isConnected(tid);
  }

  /**
   * Marks a container as having completed the ready handshake.
   */
  setReady(tid: string): void {
    this._hub.setReady(tid);
  }

  /**
   * Checks whether a container has completed the ready handshake.
   */
  isReady(tid: string): boolean {
    return this._hub.isReady(tid);
  }

  /**
   * Returns the TIDs of all currently connected containers.
   */
  getConnectedTeams(): string[] {
    return this._hub.getConnectedTeams();
  }

  /**
   * Routes a message between containers with INV-02/03 validation.
   * One of sourceTid or targetTid must be 'root'.
   *
   * @throws ValidationError if INV-02/03 is violated
   * @throws NotFoundError if target connection not found
   */
  route(sourceTid: string, targetTid: string, message: WSMessage): void {
    this._hub.route(sourceTid, targetTid, message);
  }

  /**
   * Disconnects a specific container's WebSocket connection.
   *
   * Used for protocol violations or when a container needs to be forcibly
   * disconnected (e.g., major protocol version mismatch on ready message).
   *
   * @param tid - The team ID of the container to disconnect.
   * @param code - WebSocket close code (default: 1002 for protocol error).
   * @param reason - Human-readable reason for disconnection.
   */
  disconnect(tid: string, code: number = 1002, reason: string = 'Protocol error'): void {
    const adapter = this._adapters.get(tid);
    if (adapter) {
      adapter.close(code, reason);
      this._hub.unregister(tid);
      this._adapters.delete(tid);
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Registers a newly upgraded WebSocket connection with the hub.
   * Creates a WSConnection adapter and wires up message/close handlers.
   *
   * @param isReconnect - True when the connection was authenticated via session token
   *                      (i.e. the container is reconnecting after a disconnect). The
   *                      onConnect callback receives this flag so it can skip sending
   *                      a redundant container_init (AC-A3).
   */
  private _registerConnection(tid: string, ws: WebSocket, isReconnect: boolean): void {
    // Create adapter for this connection
    const adapter = new WebSocketConnectionAdapter(tid, ws);

    // Register with the hub (handles rate limiting, write queue, etc.)
    this._hub.register(tid, adapter);
    this._adapters.set(tid, adapter);

    // Notify callback of new connection
    this._callbacks.onConnect(tid, isReconnect);

    // Wire up message handling (validation + callback)
    adapter.onMessage((msg) => {
      try {
        validateMessagePayload(msg);
        this._callbacks.onMessage(tid, msg);
      } catch {
        // Malformed message — close with policy violation
        ws.close(1008, 'Invalid message');
      }
    });

    // Wire up disconnect handling
    adapter.onClose(() => {
      this._hub.unregister(tid);
      this._adapters.delete(tid);
      this._callbacks.onDisconnect(tid);
    });
  }
}
