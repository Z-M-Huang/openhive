/**
 * WebSocket client for non-root containers.
 *
 * Connects to the root container's WS hub at:
 *   ws://openhive:8080/ws/container?team=<tid>&token=<token>
 *
 * Maintains a single persistent bidirectional JSON channel to root.
 * All inter-container communication goes through root — no direct
 * container-to-container connections (INV-03).
 *
 * Reconnection strategy (exponential backoff):
 *   - Base delay: 1 second
 *   - Multiplier: 2x per attempt
 *   - Maximum delay: 30 seconds
 *   - Jitter: +/- 20% of computed delay
 *   - Maximum attempts: unlimited (reconnects forever)
 *
 * Keep-alive:
 *   - Ping interval: 30 seconds
 *   - Pong deadline: 10 seconds (connection considered dead if exceeded)
 */

import WebSocket from 'ws';
import type { WSConnection, WSMessage } from '../domain/interfaces.js';
import { parseMessage } from '../websocket/protocol.js';
import { InternalError } from '../domain/errors.js';

/**
 * Configuration for the WebSocket client connection.
 */
export interface WSConnectionConfig {
  /** Team identifier for this container. */
  tid: string;

  /** One-time authentication token issued by root's TokenManager. */
  token: string;

  /**
   * Root hub URL base (default: ws://openhive:8080).
   * Full URL: {hubUrl}/ws/container?team={tid}&token={token}
   */
  hubUrl?: string;

  /**
   * Reconnection base delay in milliseconds.
   * @default 1000
   */
  reconnectBaseMs?: number;

  /**
   * Reconnection delay multiplier applied per attempt.
   * @default 2
   */
  reconnectMultiplier?: number;

  /**
   * Maximum reconnection delay in milliseconds.
   * @default 30000
   */
  reconnectMaxMs?: number;

  /**
   * Jitter factor applied to reconnection delay (+/- this fraction).
   * @default 0.2
   */
  reconnectJitter?: number;

  /**
   * Ping interval in milliseconds for keep-alive.
   * @default 30000
   */
  pingIntervalMs?: number;

  /**
   * Maximum time to wait for a pong response before considering
   * the connection dead, in milliseconds.
   * @default 10000
   */
  pongDeadlineMs?: number;
}

/**
 * Converts a domain WSMessage to JSON wire format.
 * Uses JSON.stringify directly (same approach as WSServer.send()).
 */
function toWire(message: WSMessage): string {
  return JSON.stringify({ type: message.type, data: message.data });
}

/**
 * Converts the protocol-typed parseMessage() result to the domain WSMessage interface.
 * The protocol union's data fields are typed interfaces that aren't structurally
 * assignable to Record<string, unknown>, so we cast through unknown (same as server.ts).
 */
function toDomainMessage(raw: string): WSMessage {
  const parsed = parseMessage(raw);
  return {
    type: parsed.type,
    data: parsed.data as unknown as Record<string, unknown>,
  };
}

/**
 * WebSocket client connection for non-root containers.
 *
 * Implements the {@link WSConnection} interface for the client side.
 * Non-root containers use this to establish and maintain a persistent
 * WebSocket connection to the root hub.
 *
 * Connection lifecycle:
 *   1. {@link connect} — opens the WS to root, authenticates via one-time token.
 *   2. Messages flow bidirectionally via {@link send} and {@link onMessage}.
 *   3. Keep-alive pings are sent every 30s; pong must arrive within 10s.
 *   4. On unexpected close, exponential backoff reconnection kicks in:
 *      delay = min(base * multiplier^attempt, maxDelay) * (1 +/- jitter).
 *   5. {@link disconnect} — graceful close, stops reconnection attempts.
 *
 * @example
 * ```ts
 * const conn = new WSConnectionImpl({ tid: 'tid-abc-123', token: 'one-time-token' });
 * conn.onMessage((msg) => console.log('received:', msg));
 * conn.onClose((code, reason) => console.log('closed:', code, reason));
 * await conn.connect();
 * conn.send({ type: 'ready', data: { team_id: 'tid-abc-123', agent_count: 2, protocol_version: '1.0' } });
 * ```
 */
export class WSConnectionImpl implements WSConnection {
  readonly tid: string;
  private readonly _hubUrl: string;
  private readonly _token: string;
  private readonly _reconnectBaseMs: number;
  private readonly _reconnectMultiplier: number;
  private readonly _reconnectMaxMs: number;
  private readonly _reconnectJitter: number;
  private readonly _pingIntervalMs: number;
  private readonly _pongDeadlineMs: number;

  private _ws: WebSocket | null = null;
  private _disconnecting = false;
  private _attempt = 0;
  private _pingTimer: ReturnType<typeof setInterval> | null = null;
  private _pongDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _pongReceived = true;
  private _messageHandler: ((msg: WSMessage) => void) | null = null;
  private _closeHandler: ((code: number, reason: string) => void) | null = null;

  constructor(config: WSConnectionConfig) {
    this.tid = config.tid;
    this._token = config.token;
    this._hubUrl = config.hubUrl ?? 'ws://openhive:8080';
    this._reconnectBaseMs = config.reconnectBaseMs ?? 1000;
    this._reconnectMultiplier = config.reconnectMultiplier ?? 2;
    this._reconnectMaxMs = config.reconnectMaxMs ?? 30000;
    this._reconnectJitter = config.reconnectJitter ?? 0.2;
    this._pingIntervalMs = config.pingIntervalMs ?? 30000;
    this._pongDeadlineMs = config.pongDeadlineMs ?? 10000;
  }

  /**
   * Opens the WebSocket connection to root's hub.
   *
   * Constructs the URL as: {hubUrl}/ws/container?team={tid}&token={token}
   * (default hubUrl: ws://openhive:8080). The one-time token is validated
   * during the HTTP upgrade handshake by root's TokenManager.
   *
   * On successful connection, starts the ping/pong keep-alive timer
   * (30s interval, 10s pong deadline). On failure, begins exponential
   * backoff reconnection (1s base, 2x multiplier, 30s max, +/-20% jitter,
   * unlimited attempts).
   */
  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = this._createSocket();

      ws.on('open', () => {
        this._ws = ws;
        this._attempt = 0;
        this._pongReceived = true;
        this._startPingPong();
        resolve();
      });

      ws.on('error', (err: Error) => {
        // If not yet connected, reject the connect() promise
        if (this._ws === null && ws.readyState !== WebSocket.OPEN) {
          if (this._attempt === 0) {
            reject(err);
          }
        }
      });
    });
  }

  /**
   * Gracefully disconnects from the root hub.
   *
   * Stops the ping/pong keep-alive timer and the reconnection backoff.
   * Closes the underlying WebSocket with code 1000 (Normal Closure).
   * No further reconnection attempts are made after disconnect().
   */
  async disconnect(): Promise<void> {
    this._disconnecting = true;
    this._stopPingPong();
    this._clearReconnectTimer();

    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      return new Promise<void>((resolve) => {
        this._ws!.once('close', () => resolve());
        this._ws!.close(1000, 'Normal closure');
      });
    }

    this._ws = null;
  }

  /**
   * Sends a typed message to root over the WebSocket connection.
   *
   * The message is serialized to wire format (JSON) before sending.
   * Only container-to-root message types should be sent from this client.
   *
   * @param message - The WSMessage to send to root.
   * @throws InternalError if the connection is not open.
   */
  send(message: WSMessage): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      throw new InternalError('WebSocket is not connected');
    }
    this._ws.send(toWire(message));
  }

  /**
   * Closes the underlying WebSocket connection.
   *
   * Unlike {@link disconnect}, this does not suppress reconnection.
   * If the connection was not explicitly disconnected, the backoff
   * reconnection logic will attempt to re-establish the connection.
   *
   * @param code - WebSocket close code (default: 1000).
   * @param reason - Human-readable close reason.
   */
  close(code?: number, reason?: string): void {
    if (this._ws) {
      this._ws.close(code ?? 1000, reason);
    }
  }

  /**
   * Registers a handler for incoming messages from root.
   *
   * Messages are parsed from wire format and delivered as typed WSMessage
   * objects. Only root-to-container message types are expected.
   *
   * @param handler - Callback invoked with each received WSMessage.
   */
  onMessage(handler: (message: WSMessage) => void): void {
    this._messageHandler = handler;
  }

  /**
   * Registers a handler for connection close events.
   *
   * Called when the WebSocket connection is closed, whether by the remote
   * side, a network failure, or an explicit close/disconnect call.
   *
   * @param handler - Callback invoked with the close code and reason.
   */
  onClose(handler: (code: number, reason: string) => void): void {
    this._closeHandler = handler;
  }

  /**
   * Checks whether the WebSocket connection is currently alive.
   *
   * A connection is considered alive if:
   *   - The WebSocket is in the OPEN state, AND
   *   - A pong response was received within the last pong deadline (10s)
   *     after the most recent ping.
   *
   * @returns true if the connection is open and responsive.
   */
  isAlive(): boolean {
    return this._ws !== null
      && this._ws.readyState === WebSocket.OPEN
      && this._pongReceived;
  }

  /**
   * Calculates the reconnection backoff delay for the current attempt.
   *
   * Formula: min(base * multiplier^attempt, maxDelay) * (1 +/- jitter)
   */
  calculateBackoff(): number {
    const raw = Math.min(
      this._reconnectBaseMs * Math.pow(this._reconnectMultiplier, this._attempt),
      this._reconnectMaxMs,
    );
    const jitterRange = raw * this._reconnectJitter;
    const jitter = (Math.random() * 2 - 1) * jitterRange;
    return Math.round(raw + jitter);
  }

  /** Returns the current reconnection attempt counter (for testing). */
  get attempt(): number {
    return this._attempt;
  }

  /** Returns whether the connection is in disconnecting state (for testing). */
  get disconnecting(): boolean {
    return this._disconnecting;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Creates a new WebSocket to root and wires up message/pong/close handlers. */
  private _createSocket(): WebSocket {
    const url = `${this._hubUrl}/ws/container?team=${this.tid}&token=${this._token}`;
    const ws = new WebSocket(url);

    ws.on('message', (data: WebSocket.Data) => {
      const raw = data.toString();
      try {
        const msg = toDomainMessage(raw);
        if (this._messageHandler) {
          this._messageHandler(msg);
        }
      } catch {
        // Invalid messages silently dropped on client side
      }
    });

    ws.on('pong', () => {
      this._pongReceived = true;
    });

    ws.on('close', (code: number, reason: Buffer) => {
      this._stopPingPong();
      const reasonStr = reason.toString();

      if (this._closeHandler) {
        this._closeHandler(code, reasonStr);
      }

      if (this._ws === ws) {
        this._ws = null;
      }

      if (!this._disconnecting) {
        this._scheduleReconnect();
      }
    });

    return ws;
  }

  private _startPingPong(): void {
    this._stopPingPong();
    this._pingTimer = setInterval(() => {
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        this._pongReceived = false;
        this._ws.ping();
        this._pongDeadlineTimer = setTimeout(() => {
          if (!this._pongReceived && this._ws) {
            this._ws.terminate();
          }
        }, this._pongDeadlineMs);
      }
    }, this._pingIntervalMs);
  }

  private _stopPingPong(): void {
    if (this._pingTimer !== null) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
    if (this._pongDeadlineTimer !== null) {
      clearTimeout(this._pongDeadlineTimer);
      this._pongDeadlineTimer = null;
    }
  }

  private _clearReconnectTimer(): void {
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  private _scheduleReconnect(): void {
    this._clearReconnectTimer();
    const delay = this.calculateBackoff();
    this._attempt++;
    this._reconnectTimer = setTimeout(() => {
      if (!this._disconnecting) {
        this._reconnectAttempt();
      }
    }, delay);
  }

  private _reconnectAttempt(): void {
    const ws = this._createSocket();

    ws.on('open', () => {
      this._ws = ws;
      this._attempt = 0;
      this._pongReceived = true;
      this._startPingPong();
    });

    ws.on('error', () => {
      // Error will be followed by close event which handles reconnection
    });
  }
}
