/**
 * CLI WebSocket relay for OpenHive (root-only).
 *
 * Provides a WebSocket endpoint at `/ws/cli` for remote CLI clients to send
 * messages and receive responses. Each connected client gets a unique session
 * with a chat JID of the form `cli:ws:<sessionId>`.
 *
 * Inbound JSON messages from the WebSocket are routed through the
 * {@link MessageRouter} pipeline (same as the in-process CLIAdapter).
 * Outbound responses are pushed back to the originating WebSocket client.
 *
 * **Protocol:**
 * - Client sends: `{ "type": "message", "content": "user text" }`
 * - Server sends: `{ "type": "response", "content": "assistant response" }`
 *
 * **Root-only module:** This relay is only started when `OPENHIVE_IS_ROOT=true`.
 *
 * @module api/cli-ws
 */

import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { MessageRouter, InboundMessage } from '../domain/index.js';
import { ChannelType } from '../domain/enums.js';
import { BaseChannelAdapter } from '../channels/adapter.js';
import type { OutboundMessage } from '../channels/adapter.js';

/**
 * Configuration options for the CLI WebSocket relay.
 */
export interface CLIWSRelayConfig {
  /**
   * The MessageRouter instance for routing inbound messages.
   */
  messageRouter: MessageRouter;

  /**
   * Optional WebSocket path for CLI connections.
   * @default '/ws/cli'
   */
  path?: string;
}

/**
 * Channel adapter that bridges WebSocket CLI connections to the MessageRouter.
 *
 * Each WebSocket connection is tracked by session ID. Outbound messages are
 * routed to the correct WebSocket based on the `cli:ws:<sessionId>` chatJid.
 */
class CLIWSAdapter extends BaseChannelAdapter {
  private readonly connections = new Map<string, WebSocket>();

  /**
   * Add a WebSocket connection with its session ID.
   */
  addConnection(sessionId: string, ws: WebSocket): void {
    this.connections.set(sessionId, ws);
  }

  /**
   * Remove a WebSocket connection by session ID.
   */
  removeConnection(sessionId: string): void {
    this.connections.delete(sessionId);
  }

  /**
   * Get the number of active connections.
   */
  getConnectionCount(): number {
    return this.connections.size;
  }

  /**
   * No-op — connections are managed externally by the relay.
   */
  async connect(): Promise<void> {
    // No-op: connections are managed by CLIWSRelay
  }

  /**
   * Close all connections.
   */
  async disconnect(): Promise<void> {
    for (const [sessionId, ws] of this.connections) {
      try {
        ws.close(1000, 'Server shutting down');
      } catch {
        // Ignore errors on close
      }
      this.connections.delete(sessionId);
    }
  }

  /**
   * Send a response to the appropriate WebSocket client based on chatJid.
   *
   * Only handles `cli:ws:*` JIDs. Extracts the session ID from the JID
   * and sends the response JSON to the corresponding WebSocket.
   *
   * @throws Error if the chatJid does not match `cli:ws:*` format
   */
  async sendMessage(msg: OutboundMessage): Promise<void> {
    // Only handle cli:ws: prefixed JIDs
    if (!msg.chatJid.startsWith('cli:ws:')) {
      throw new Error(`CLIWSAdapter does not handle chatJid: ${msg.chatJid}`);
    }

    const sessionId = msg.chatJid.slice('cli:ws:'.length);
    const ws = this.connections.get(sessionId);

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error(`No active WebSocket for session: ${sessionId}`);
    }

    const response = JSON.stringify({
      type: 'response',
      content: msg.content,
    });

    ws.send(response);
  }

  /**
   * Emit an inbound message to registered handlers.
   * Called by CLIWSRelay when a WebSocket message arrives.
   */
  async emitInbound(msg: InboundMessage): Promise<void> {
    await this.notifyHandlers(msg);
  }
}

/**
 * CLI WebSocket relay that bridges remote CLI clients to the MessageRouter.
 *
 * Responsibilities:
 * - Accepts WebSocket connections from CLI clients on `/ws/cli`
 * - Assigns each connection a unique session ID and `cli:ws:<sessionId>` JID
 * - Parses inbound JSON messages and routes them through the MessageRouter
 * - Registers a CLIWSAdapter with the MessageRouter for response delivery
 * - Manages connection lifecycle (connect, disconnect, cleanup)
 */
export class CLIWSRelay {
  private readonly _config: CLIWSRelayConfig;
  private wss: WebSocketServer | null = null;
  private adapter: CLIWSAdapter | null = null;
  private started = false;

  constructor(config: CLIWSRelayConfig) {
    this._config = config;
  }

  /**
   * Start the CLI WebSocket relay.
   *
   * 1. Create a `noServer` WebSocketServer
   * 2. Register upgrade handler for `/ws/cli` path
   * 3. Create and register CLIWSAdapter with the MessageRouter
   * 4. Handle incoming connections and messages
   *
   * @param server - The HTTP server to attach the WebSocket upgrade handler to
   */
  async start(server: ReturnType<typeof import('node:http').createServer>): Promise<void> {
    if (this.started) {
      return;
    }

    const path = this._config.path ?? '/ws/cli';

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

      this.wss!.handleUpgrade(request, socket, head, (ws) => {
        this.wss!.emit('connection', ws, request);
      });
    });

    // Create and register the adapter under ChannelType.Api to avoid
    // overwriting the in-process CLIAdapter (which uses ChannelType.Cli).
    // Both adapters coexist: CLIWSAdapter handles cli:ws:* JIDs,
    // CLIAdapter handles cli:local:* JIDs. sendResponse() iterates all
    // adapters and each throws for JIDs it doesn't own.
    this.adapter = new CLIWSAdapter();
    this._config.messageRouter.registerChannel(ChannelType.Api, this.adapter);

    // Handle new connections
    this.wss.on('connection', (ws: WebSocket) => {
      const sessionId = crypto.randomUUID();

      this.adapter!.addConnection(sessionId, ws);

      // Send welcome message
      ws.send(JSON.stringify({
        type: 'connected',
        sessionId,
      }));

      // Handle incoming messages
      ws.on('message', (data) => {
        try {
          const parsed = JSON.parse(data.toString());

          if (parsed.type === 'message' && typeof parsed.content === 'string') {
            const inbound: InboundMessage = {
              id: crypto.randomUUID(),
              chatJid: `cli:ws:${sessionId}`,
              channelType: ChannelType.Cli,
              content: parsed.content,
              timestamp: Date.now(),
            };

            // Route through message router (async, don't block WebSocket)
            void this.adapter!.emitInbound(inbound);
          }
        } catch {
          // Ignore malformed messages
        }
      });

      // Handle disconnect
      ws.on('close', () => {
        this.adapter!.removeConnection(sessionId);
      });

      // Handle errors
      ws.on('error', () => {
        this.adapter!.removeConnection(sessionId);
      });
    });

    this.started = true;
  }

  /**
   * Gracefully stop the CLI WebSocket relay.
   *
   * 1. Disconnect the adapter (closes all WebSocket connections)
   * 2. Close the WebSocket server
   */
  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    // Disconnect adapter (closes all client connections)
    if (this.adapter) {
      await this.adapter.disconnect();
      this.adapter = null;
    }

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
   * Get the number of currently connected CLI clients.
   */
  getClientCount(): number {
    return this.adapter?.getConnectionCount() ?? 0;
  }

  /**
   * Check if the relay is started.
   */
  isStarted(): boolean {
    return this.started;
  }
}
