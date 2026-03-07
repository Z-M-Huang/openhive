/**
 * OpenHive Backend - WebSocket Hub
 *
 * Manages WebSocket connections from team containers using:
 *   - ws.WebSocketServer (noServer: true) for full upgrade control
 *   - Manual upgrade handling via fastify.server.on('upgrade')
 *   - One-time token authentication (TokenManager)
 *   - Origin header validation for container connections
 *   - Connection registry (Map<teamID, WSConnection>)
 *
 * Integration pattern:
 *   const hub = new Hub({ logger });
 *   hub.attachToServer(fastifyServer);
 *
 * Only '/ws/container' upgrade requests are intercepted.
 * All other upgrade paths are left for other handlers (e.g. @fastify/websocket).
 */

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Server as HttpServer } from 'node:http';
import { WebSocketServer } from 'ws';

import type { WSConnection, WSHub, FastifyUpgradeHandler } from '../domain/interfaces.js';
import { NotFoundError } from '../domain/errors.js';
import { TokenManager } from './token.js';
import { Connection } from './connection.js';

// ---------------------------------------------------------------------------
// Logger interface — minimal subset used internally
// ---------------------------------------------------------------------------

/**
 * Minimal logger interface required by Hub.
 * Matches the shape of pino or any structured logger.
 */
export interface HubLogger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

// ---------------------------------------------------------------------------
// Hub options
// ---------------------------------------------------------------------------

/**
 * Options for constructing a Hub instance.
 */
export interface HubOptions {
  /** Logger instance (pino-compatible). */
  logger: HubLogger;
  /**
   * Set of allowed Origin header values for incoming WebSocket connections.
   * If empty, all requests are allowed (including those with no Origin header).
   * If non-empty and a request has an Origin header, the value must be in this set.
   * Requests with no Origin header are always allowed (container-to-container connections).
   */
  allowedOrigins?: Set<string>;
}

// ---------------------------------------------------------------------------
// Hub — implements WSHub
// ---------------------------------------------------------------------------

/**
 * WebSocket hub that manages connections from team containers.
 *
 * Uses ws.WebSocketServer in noServer mode so the upgrade handshake
 * is controlled manually (auth + origin validation before the WS upgrade).
 *
 * Implements WSHub from domain/interfaces.ts.
 */
export class Hub implements WSHub {
  private readonly connections: Map<string, WSConnection> = new Map();
  private readonly tokenManager: TokenManager;
  private readonly wss: WebSocketServer;
  private readonly logger: HubLogger;
  private readonly allowedOrigins: Set<string>;

  private onMessageHandler: ((teamID: string, msg: Buffer) => void) | null = null;
  private onConnectHandler: ((teamID: string) => void) | null = null;

  constructor(opts: HubOptions) {
    this.logger = opts.logger;
    this.allowedOrigins = opts.allowedOrigins ?? new Set<string>();
    this.tokenManager = new TokenManager();
    this.wss = new WebSocketServer({ noServer: true });
  }

  // ---------------------------------------------------------------------------
  // WSHub interface implementation
  // ---------------------------------------------------------------------------

  /**
   * Registers a WebSocket connection for the given team ID.
   * If a connection already exists for the team, it is closed before replacing.
   */
  registerConnection(teamID: string, conn: WSConnection): void {
    const existing = this.connections.get(teamID);
    if (existing !== undefined) {
      // Close the existing connection (ignore errors — connection may already be dead)
      existing.close().catch(() => undefined);
    }
    this.connections.set(teamID, conn);
  }

  /**
   * Removes the connection for the given team ID from the registry.
   */
  unregisterConnection(teamID: string): void {
    this.connections.delete(teamID);
  }

  /**
   * Sends a message to a specific team's connection.
   * Throws NotFoundError if the team is not connected.
   */
  async sendToTeam(teamID: string, msg: Buffer | string): Promise<void> {
    const conn = this.connections.get(teamID);
    if (conn === undefined) {
      throw new NotFoundError('ws_connection', teamID);
    }

    this.logger.debug('ws message sent', { team_id: teamID, size: msg.length });
    await conn.send(msg);
  }

  /**
   * Sends a message to all connected team containers.
   * Individual send failures are logged but do not interrupt the broadcast.
   */
  async broadcastAll(msg: Buffer | string): Promise<void> {
    const conns = Array.from(this.connections.entries());
    for (const [teamID, conn] of conns) {
      try {
        await conn.send(msg);
      } catch (err) {
        this.logger.warn('broadcast send failed', {
          team_id: teamID,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Generates a one-time WebSocket authentication token for a team.
   * Delegates to TokenManager.
   */
  generateToken(teamID: string): string {
    return this.tokenManager.generateToken(teamID);
  }

  /**
   * Returns a FastifyUpgradeHandler for use with @fastify/websocket.
   *
   * When @fastify/websocket is registered, Fastify intercepts ALL upgrade
   * events. The handler receives an already-upgraded WebSocket + FastifyRequest.
   * It validates the token, creates a Connection, registers it, and fires
   * the onConnect callback.
   *
   * Usage:
   *   fastify.get('/ws/container', { websocket: true }, hub.getUpgradeHandler());
   *
   */
  getUpgradeHandler(): FastifyUpgradeHandler {
    return (socket: unknown, request: unknown): void => {
      // @fastify/websocket wraps the FastifyRequest: the actual request is at
      // request.request (with .url and .query), not directly on request.
      const reqWrapper = request as {
        request?: { url?: string; query?: Record<string, string> };
        url?: string;
        query?: Record<string, string>;
      };
      const innerReq = reqWrapper.request ?? reqWrapper;
      const token =
        innerReq.query?.['token'] ??
        new URL(innerReq.url ?? '', 'http://localhost').searchParams.get('token');

      // The socket from @fastify/websocket is a ws.WebSocket instance
      const ws = socket as import('ws').WebSocket;
      const closeWs = (code: number, reason: string): void => {
        if (typeof ws.close === 'function') {
          ws.close(code, reason);
        } else if (typeof (ws as unknown as { terminate?: () => void }).terminate === 'function') {
          (ws as unknown as { terminate: () => void }).terminate();
        }
      };

      if (token === null || token === '' || token === undefined) {
        this.logger.warn('ws upgrade rejected: missing token');
        closeWs(4001, 'missing token');
        return;
      }

      // Validate and consume the one-time token
      const [teamID, valid] = this.tokenManager.validate(token);
      if (!valid) {
        this.logger.warn('ws upgrade rejected: invalid or expired token', { token: token.slice(0, 8) + '...' });
        closeWs(4001, 'invalid or expired token');
        return;
      }
      this.tokenManager.consume(token);

      // Create the connection wrapper
      const conn = new Connection(
        ws,
        teamID,
        this.logger,
        (tid, msg) => this.handleMessage(tid, msg),
        (tid) => this.handleClose(tid),
      );

      // Register connection (closes existing if any)
      this.registerConnection(teamID, conn);

      this.logger.info('container connected', { team_id: teamID });

      // Fire the onConnect callback
      const connectHandler = this.onConnectHandler;
      if (connectHandler !== null) {
        connectHandler(teamID);
      }
    };
  }

  /**
   * Attaches the WebSocket upgrade handler to the given HTTP server.
   * Only handles requests for the '/ws/container' path.
   * All other upgrade requests are passed through to other handlers.
   *
   * Call this once at startup:
   *   hub.attachToServer(fastify.server);
   */
  attachToServer(server: HttpServer): void {
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      this.handleUpgrade(request, socket, head);
    });
  }

  /** Returns the list of team IDs that are currently connected. */
  getConnectedTeams(): string[] {
    return Array.from(this.connections.keys());
  }

  /** Sets the handler called for every message received from any container. */
  setOnMessage(handler: (teamID: string, msg: Buffer) => void): void {
    this.onMessageHandler = handler;
  }

  /**
   * Sets the handler called after a container successfully connects.
   * Used to trigger container_init after the WebSocket handshake.
   */
  setOnConnect(handler: (teamID: string) => void): void {
    this.onConnectHandler = handler;
  }

  /**
   * Closes all connections, the WebSocket server, and the token manager.
   */
  async close(): Promise<void> {
    // Close all active connections
    const closePromises: Promise<void>[] = [];
    for (const conn of this.connections.values()) {
      closePromises.push(conn.close().catch(() => undefined));
    }
    await Promise.all(closePromises);
    this.connections.clear();

    // Close the WebSocket server
    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve());
    });

    // Stop the token manager cleanup interval
    this.tokenManager.close();
  }

  // ---------------------------------------------------------------------------
  // Private — upgrade handler
  // ---------------------------------------------------------------------------

  /**
   * Handles a raw HTTP upgrade request from the server's 'upgrade' event.
   *
   * Steps:
   *   1. Check the URL path — only handle '/ws/container'. Pass all others through.
   *   2. Validate the Origin header against allowedOrigins.
   *   3. Extract and validate the token from query params.
   *   4. Perform the WebSocket upgrade via wss.handleUpgrade().
   *   5. Consume the token (one-time use), create a Connection, register it.
   *   6. Fire the onConnect callback.
   */
  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    // (1) Only handle the /ws/container path
    const url = new URL(request.url ?? '', 'http://localhost');
    if (url.pathname !== '/ws/container') {
      // Not our path — do not intercept; let other handlers deal with it
      return;
    }

    // (2) Validate Origin header
    const origin = request.headers['origin'];
    if (!this.isOriginAllowed(origin)) {
      this.logger.warn('ws upgrade rejected: disallowed origin', { origin });
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    // (3) Extract and validate token
    const token = url.searchParams.get('token');
    if (token === null || token === '') {
      this.logger.warn('ws upgrade rejected: missing token');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // Validate without consuming — token stays valid for retries if upgrade fails
    const [teamID, valid] = this.tokenManager.validate(token);
    if (!valid) {
      this.logger.warn('ws upgrade rejected: invalid or expired token', { token: token.slice(0, 8) + '...' });
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // (4) Perform the WebSocket upgrade
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      // (5) Consume the token (one-time use) — only after successful upgrade
      this.tokenManager.consume(token);

      // Create the connection wrapper
      const conn = new Connection(
        ws,
        teamID,
        this.logger,
        (tid, msg) => this.handleMessage(tid, msg),
        (tid) => this.handleClose(tid),
      );

      // Register connection (closes existing if any)
      this.registerConnection(teamID, conn);

      this.logger.info('container connected', { team_id: teamID });

      // (6) Fire the onConnect callback
      const connectHandler = this.onConnectHandler;
      if (connectHandler !== null) {
        connectHandler(teamID);
      }
    });
  }

  /**
   * Validates the Origin header of an upgrade request.
   *
   * Containers connect without a browser Origin header — no-origin requests
   * are always allowed. If an Origin header is present and allowedOrigins is
   * non-empty, the value must be in the set.
   *
   * If allowedOrigins is empty, all Origins (including browser ones) are allowed.
   */
  private isOriginAllowed(origin: string | undefined): boolean {
    // No Origin header — always allowed (container-to-container)
    if (origin === undefined || origin === '') {
      return true;
    }

    // If allowedOrigins is empty, allow all
    if (this.allowedOrigins.size === 0) {
      return true;
    }

    // Origin present and allowedOrigins configured — must be in the set
    return this.allowedOrigins.has(origin);
  }

  /**
   * Internal message handler — called by each Connection when it receives data.
   */
  private handleMessage(teamID: string, msg: Buffer): void {
    this.logger.debug('ws message received', { team_id: teamID, size: msg.length });

    const handler = this.onMessageHandler;
    if (handler !== null) {
      handler(teamID, msg);
    }
  }

  /**
   * Internal close handler — called by each Connection when it closes.
   * Removes the connection from the registry.
   */
  private handleClose(teamID: string): void {
    this.unregisterConnection(teamID);
    this.logger.info('container disconnected', { team_id: teamID });
  }
}
