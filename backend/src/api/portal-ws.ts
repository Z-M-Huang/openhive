/**
 * Portal WebSocket relay for OpenHive (root-only).
 *
 * Provides a secondary WebSocket connection from the REST API server for the
 * web portal. Unlike the container-facing WSHub (which uses the internal
 * hub-and-spoke protocol), this relay bridges internal {@link EventBus} events
 * to browser clients over standard WebSocket frames.
 *
 * **Relayed event prefixes:**
 * - `heartbeat` — container/agent health status updates (exact match, e.g. `heartbeat`)
 * - `task.` — task lifecycle transitions (e.g. `task.dispatched`, `task.completed`, `task.failed`)
 * - `container.` — container lifecycle events (e.g. `container.spawned`, `container.stopped`)
 * - `agent.` — agent lifecycle events (e.g. `agent.added`, `agent.removed`, `agent.ready`)
 * - `team.` — team topology changes (e.g. `team.created`, `team.removed`)
 * - `health.` — health status updates (e.g. `health.degraded`, `health.recovered`)
 * - `escalation.` — escalation lifecycle events (e.g. `escalation.raised`, `escalation.resolved`)
 * - `webhook.` — webhook trigger events (e.g. `webhook.received`)
 * - `tool.` — tool call events (e.g. `tool.called`, `tool.result`)
 *
 * **Connection lifecycle:**
 * 1. Browser opens a WebSocket to `/ws/portal` on the API server
 * 2. The relay subscribes to relevant EventBus topics
 * 3. Events are serialized as JSON and broadcast to all connected portal clients
 * 4. On disconnect, per-client subscriptions are cleaned up
 *
 * **Root-only module:** This relay is only started when `OPENHIVE_IS_ROOT=true`.
 * Non-root containers do not serve portal WebSocket connections.
 *
 * @example
 * ```ts
 * const relay = new PortalWSRelay({ eventBus, server });
 * await relay.start();
 * // Browser clients can now connect to ws://host:port/ws/portal
 * relay.broadcast({ type: 'task', data: { taskId: '123', status: 'completed' } });
 * await relay.stop();
 * ```
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { BusEvent, EventBus } from '../domain/index.js';

/**
 * Event type prefixes relayed to portal WebSocket clients.
 *
 * Each entry is either:
 * - An exact type name (e.g. `heartbeat`) — matched with `===`
 * - A dotted prefix (e.g. `task.`) — matched with `startsWith`
 *
 * The filter predicate accepts an event when its type equals a prefix exactly
 * OR starts with the prefix, so both `heartbeat` and `task.dispatched` are
 * correctly forwarded to browser clients.
 */
export const PORTAL_EVENT_PREFIXES = [
  'heartbeat',
  'task.',
  'container.',
  'agent.',
  'team.',
  'health.',
  'escalation.',
  'webhook.',
  'tool.',
] as const;

/**
 * Configuration options for the portal WebSocket relay.
 */
export interface PortalWSRelayConfig {
  /**
   * The EventBus instance to subscribe to for internal system events.
   * The relay listens for heartbeat, task, and org-chart events and
   * forwards them to connected browser clients.
   */
  eventBus: EventBus;

  /**
   * Optional WebSocket path for portal connections.
   * @default '/ws/portal'
   */
  path?: string;

  /**
   * Allowed origins for WebSocket connections.
   * Used for origin validation during the WebSocket handshake.
   * @default ['http://localhost:3000', 'http://localhost:5173']
   */
  allowedOrigins?: string[];
}

/**
 * Portal WebSocket relay that bridges internal EventBus events to browser clients.
 *
 * Responsibilities:
 * - Accepts WebSocket connections from the web portal SPA
 * - Subscribes to the internal {@link EventBus} for heartbeat, task, and org-chart events
 * - Serializes and broadcasts matching events to all connected portal clients
 * - Manages per-client connection lifecycle (connect, disconnect, cleanup)
 *
 * This is distinct from the {@link WSHub} which handles the internal
 * hub-and-spoke protocol between root and team containers. The PortalWSRelay
 * is a read-only fan-out to browser clients for real-time UI updates.
 */
export class PortalWSRelay {
  private readonly _config: PortalWSRelayConfig;
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private subscriptionId: string | null = null;
  private started = false;

  constructor(config: PortalWSRelayConfig) {
    this._config = config;
  }

  /**
   * Get the default allowed origins list.
   */
  private getDefaultAllowedOrigins(): string[] {
    return [
      'http://localhost:3000',
      'http://localhost:5173',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:5173',
    ];
  }

  /**
   * Validate the origin of an incoming WebSocket connection.
   * Returns true if the origin is allowed, false otherwise.
   */
  private isOriginAllowed(origin: string | undefined): boolean {
    const allowedOrigins = this._config.allowedOrigins ?? this.getDefaultAllowedOrigins();

    // Allow connections with no origin (e.g., from same origin or non-browser clients)
    if (!origin) {
      return true;
    }

    return allowedOrigins.includes(origin);
  }

  /**
   * Start the portal WebSocket relay.
   *
   * Initialization sequence:
   * 1. Set up WebSocket server or attach to existing HTTP server upgrade path
   * 2. Subscribe to EventBus for heartbeat, task, and org-chart event types
   * 3. Register connection handler for incoming browser WebSocket connections
   * 4. Begin relaying matching events to all connected clients
   *
   * @param server - The HTTP server to attach the WebSocket server to
   * @throws Error if the relay fails to initialize or subscribe to the EventBus
   */
  async start(server: ReturnType<typeof import('node:http').createServer>): Promise<void> {
    if (this.started) {
      return;
    }

    const path = this._config.path ?? '/ws/portal';

    // Create WebSocket server
    this.wss = new WebSocketServer({
      noServer: true,
      path,
    });

    // Handle upgrade requests
    server.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
      const url = request.url ?? '';

      if (!url.startsWith(path)) {
        return; // Not our path, let other handlers deal with it
      }

      // Origin validation (AC-L10-06)
      const origin = request.headers.origin;
      if (!this.isOriginAllowed(origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss!.handleUpgrade(request, socket, head, (ws) => {
        this.wss!.emit('connection', ws, request);
      });
    });

    // Handle new connections
    this.wss.on('connection', (ws: WebSocket) => {
      this.clients.add(ws);

      // Send welcome message
      this.sendToClient(ws, {
        type: 'connected',
        data: { timestamp: Date.now() },
        timestamp: Date.now(),
      });

      // Handle client disconnect
      ws.on('close', () => {
        this.clients.delete(ws);
      });

      // Handle errors
      ws.on('error', (error) => {
        console.error('PortalWSRelay client error:', error);
        this.clients.delete(ws);
      });

      // Handle incoming messages (typically client doesn't send, but handle anyway)
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          // Could handle ping/pong or subscription requests here
          if (message.type === 'ping') {
            this.sendToClient(ws, { type: 'pong', data: {}, timestamp: Date.now() });
          }
        } catch {
          // Ignore malformed messages
        }
      });
    });

    // Subscribe to EventBus for relevant events using prefix-based filter.
    // Dotted event types (e.g. 'task.dispatched') are matched via startsWith;
    // bare types (e.g. 'heartbeat') are matched with exact equality.
    this.subscriptionId = this._config.eventBus.filteredSubscribe(
      (event: BusEvent) =>
        PORTAL_EVENT_PREFIXES.some(
          (p) => event.type === p || event.type.startsWith(p)
        ),
      (event: BusEvent) => {
        this.broadcast(event);
      }
    );

    this.started = true;
  }

  /**
   * Gracefully stop the portal WebSocket relay.
   *
   * Shutdown sequence:
   * 1. Unsubscribe from all EventBus subscriptions
   * 2. Send close frames to all connected portal clients
   * 3. Close the WebSocket server and release resources
   *
   * Safe to call multiple times. After stopping, no further events
   * are relayed and new connections are rejected.
   */
  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    // Unsubscribe from EventBus
    if (this.subscriptionId) {
      this._config.eventBus.unsubscribe(this.subscriptionId);
      this.subscriptionId = null;
    }

    // Close all client connections
    for (const client of this.clients) {
      try {
        client.close(1000, 'Server shutting down');
      } catch {
        // Ignore errors on close
      }
    }
    this.clients.clear();

    // Close WebSocket server
    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss!.close(() => resolve());
      });
      this.wss = null;
    }

    this.started = false;
  }

  /**
   * Send a message to a specific client.
   */
  private sendToClient(ws: WebSocket, event: BusEvent): void {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      ws.send(JSON.stringify(event));
    } catch (error) {
      console.error('PortalWSRelay send error:', error);
    }
  }

  /**
   * Broadcast an event to all connected portal WebSocket clients.
   *
   * The event is serialized as a JSON string and sent to every currently
   * connected browser client. Clients that have disconnected or whose
   * send buffers are full are skipped (with a warning logged).
   *
   * @param event - The bus event to broadcast. Must include `type` and `data` fields.
   *                Typically one of: heartbeat, task, or org-chart event types.
   */
  broadcast(event: BusEvent): void {
    if (!this.started) {
      return;
    }

    const message = JSON.stringify(event);
    const deadClients: WebSocket[] = [];

    for (const client of this.clients) {
      if (client.readyState !== WebSocket.OPEN) {
        deadClients.push(client);
        continue;
      }

      try {
        client.send(message);
      } catch (error) {
        console.warn('PortalWSRelay broadcast error:', error);
        deadClients.push(client);
      }
    }

    // Clean up dead clients
    for (const dead of deadClients) {
      this.clients.delete(dead);
    }
  }

  /**
   * Get the number of currently connected clients.
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Check if the relay is started.
   */
  isStarted(): boolean {
    return this.started;
  }
}