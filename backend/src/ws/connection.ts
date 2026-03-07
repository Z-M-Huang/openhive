/**
 * OpenHive Backend - WebSocket Connection Wrapper
 *
 * Event-driven WebSocket connection using the ws library.
 *
 *   readPump  → ws 'message' event handler
 *   writePump → write queue flushed via queueMicrotask
 *   pong wait → pong deadline timer reset on each 'pong' event
 *
 * Constants:
 *   writeQueueSize   = 256   (write buffer capacity)
 *   maxMessageSize   = 1 MB
 *   pingInterval     = 30 s
 *   pongDeadline     = 10 s  (close if no pong within this window after ping)
 *   messageRateLimit = 100 msgs/sec
 *   messageRateBurst = 100
 */

import type WebSocket from 'ws';
import type { WSConnection } from '../domain/interfaces.js';

// ---------------------------------------------------------------------------
// WebSocket constants
// ---------------------------------------------------------------------------

const WRITE_QUEUE_SIZE = 256;
const MAX_MESSAGE_SIZE = 1 * 1024 * 1024; // 1 MB

const PING_INTERVAL_MS = 30 * 1000;  // 30 s
const PONG_DEADLINE_MS = 10 * 1000;  // 10 s

const MESSAGE_RATE_LIMIT = 100; // tokens per second
const MESSAGE_RATE_BURST = 100; // burst capacity

// ---------------------------------------------------------------------------
// WriteError
// ---------------------------------------------------------------------------

/** Thrown when the write queue is full and the connection has been closed. */
export class WriteError extends Error {
  constructor(readonly teamId: string) {
    super(`write queue full for team ${teamId}`);
    this.name = 'WriteError';
  }
}

// ---------------------------------------------------------------------------
// SlidingWindowRateLimiter — token bucket approximation
// ---------------------------------------------------------------------------

/**
 * Simple token bucket rate limiter.
 *
 *   - Rate: `rate` tokens added per second continuously.
 *   - Burst: maximum `burst` tokens that can accumulate.
 *   - allow(): consume 1 token; return false if no tokens available.
 *
 * Token refill is computed lazily on each allow() call.
 */
class TokenBucketRateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly rate: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
    this.lastRefill = Date.now();
  }

  allow(): boolean {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000; // seconds
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rate);
    this.lastRefill = now;

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Logger interface — minimal subset used internally
// ---------------------------------------------------------------------------

/**
 * Minimal logger interface required by Connection.
 * Matches the shape of pino or any structured logger.
 */
export interface Logger {
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

// ---------------------------------------------------------------------------
// Connection — implements WSConnection
// ---------------------------------------------------------------------------

/**
 * Wraps a ws.WebSocket instance with:
 *   - Write queue (256-message cap, closes connection if full)
 *   - Token bucket rate limiter (100 msgs/sec, burst 100)
 *   - Ping/pong keepalive (ping every 30 s, close if no pong within 10 s)
 *   - 1 MB inbound message size limit
 *   - onMessage and onClose callbacks
 *
 * Implements WSConnection from domain/interfaces.ts.
 */
export class Connection implements WSConnection {
  private readonly _teamId: string;
  private readonly socket: WebSocket;
  private readonly logger: Logger;
  private readonly onMessageCb: (teamId: string, msg: Buffer) => void;
  private readonly onCloseCb: (teamId: string) => void;

  // Write queue
  private readonly writeQueue: Array<Buffer | string> = [];
  private writeFlushing = false;

  // Rate limiter
  private readonly rateLimiter: TokenBucketRateLimiter;

  // Keepalive state
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongDeadlineTimer: ReturnType<typeof setTimeout> | null = null;

  // Closed flag — prevents double-close and double onClose firing
  private closed = false;

  constructor(
    socket: WebSocket,
    teamId: string,
    logger: Logger,
    onMessage: (teamId: string, msg: Buffer) => void,
    onClose: (teamId: string) => void,
  ) {
    this.socket = socket;
    this._teamId = teamId;
    this.logger = logger;
    this.onMessageCb = onMessage;
    this.onCloseCb = onClose;

    this.rateLimiter = new TokenBucketRateLimiter(MESSAGE_RATE_LIMIT, MESSAGE_RATE_BURST);

    this.attachEventHandlers();
    this.startKeepalive();
  }

  // ---------------------------------------------------------------------------
  // WSConnection interface implementation
  // ---------------------------------------------------------------------------

  /** Returns the team ID for this connection. */
  teamID(): string {
    return this._teamId;
  }

  /**
   * Queues a message for delivery over the WebSocket.
   * If the queue is at capacity (256), the connection is closed and a
   * WriteError is thrown.
   */
  async send(msg: Buffer | string): Promise<void> {
    if (this.closed) {
      throw new WriteError(this._teamId);
    }

    if (this.writeQueue.length >= WRITE_QUEUE_SIZE) {
      this.logger.warn('write queue full, closing connection', { team_id: this._teamId });
      this.internalClose();
      throw new WriteError(this._teamId);
    }

    this.writeQueue.push(msg);
    this.scheduleFlush();
  }

  /**
   * Closes the WebSocket connection and cleans up timers.
   * Idempotent — safe to call multiple times.
   */
  async close(): Promise<void> {
    this.internalClose();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Attaches ws event handlers for message reception, close, and pong.
   */
  private attachEventHandlers(): void {
    this.socket.on('message', (data: WebSocket.RawData, _isBinary: boolean) => {
      // Enforce 1 MB message size limit
      const buf = toBuffer(data);
      if (buf.length > MAX_MESSAGE_SIZE) {
        this.logger.warn('message exceeds max size, closing connection', {
          team_id: this._teamId,
          size: buf.length,
        });
        this.internalClose();
        return;
      }

      // Rate limit check
      if (!this.rateLimiter.allow()) {
        this.logger.warn('rate limit exceeded, closing connection', {
          team_id: this._teamId,
        });
        this.internalClose();
        return;
      }

      this.onMessageCb(this._teamId, buf);
    });

    this.socket.on('close', () => {
      this.internalClose();
    });

    this.socket.on('error', (err: Error) => {
      this.logger.error('WebSocket error', { team_id: this._teamId, error: err.message });
      this.internalClose();
    });

    // Pong received — cancel pending deadline timer, it will be restarted on next ping
    this.socket.on('pong', () => {
      this.clearPongDeadline();
    });
  }

  /**
   * Starts the ping keepalive interval (every 30 s).
   * Each ping arms a 10 s pong deadline timer; receiving a pong clears it.
   */
  private startKeepalive(): void {
    this.pingTimer = setInterval(() => {
      if (this.closed) return;

      // Arm pong deadline before sending the ping
      this.armPongDeadline();

      this.socket.ping(undefined, undefined, (err?: Error) => {
        if (err != null) {
          this.logger.error('ping error', { team_id: this._teamId, error: err.message });
          this.internalClose();
        }
      });
    }, PING_INTERVAL_MS);
  }

  /**
   * Arms the pong deadline timer. If it fires, the connection is closed.
   * Clears any existing pong deadline timer first.
   */
  private armPongDeadline(): void {
    this.clearPongDeadline();
    this.pongDeadlineTimer = setTimeout(() => {
      this.logger.warn('pong deadline exceeded, closing connection', {
        team_id: this._teamId,
      });
      this.internalClose();
    }, PONG_DEADLINE_MS);
  }

  /** Clears the pong deadline timer. */
  private clearPongDeadline(): void {
    if (this.pongDeadlineTimer !== null) {
      clearTimeout(this.pongDeadlineTimer);
      this.pongDeadlineTimer = null;
    }
  }

  /**
   * Internal close — idempotent.
   * Closes the WebSocket, cancels timers, fires onClose callback once.
   */
  private internalClose(): void {
    if (this.closed) return;
    this.closed = true;

    // Cancel timers
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.clearPongDeadline();

    // Close the socket (terminate avoids the closing handshake delay)
    try {
      this.socket.terminate();
    } catch {
      // Socket may already be closed; ignore
    }

    // Notify caller
    this.onCloseCb(this._teamId);
  }

  /**
   * Schedules a flush of the write queue via queueMicrotask.
   * queueMicrotask is preferred over setImmediate because it integrates
   * cleanly with both real async code and test environments that fake timers
   * (setImmediate is not consistently faked across environments).
   * If a flush is already scheduled or running, this is a no-op.
   */
  private scheduleFlush(): void {
    if (this.writeFlushing) return;
    this.writeFlushing = true;
    queueMicrotask(() => this.flushWriteQueue());
  }

  /**
   * Drains the write queue, sending each message in order.
   * Each send invokes the callback asynchronously; we continue flushing
   * via queueMicrotask to avoid blocking the event loop.
   * Stops if the connection closes mid-flush.
   */
  private flushWriteQueue(): void {
    if (this.closed) {
      this.writeQueue.length = 0;
      this.writeFlushing = false;
      return;
    }

    const msg = this.writeQueue.shift();
    if (msg === undefined) {
      this.writeFlushing = false;
      return;
    }

    this.socket.send(msg, (err?: Error) => {
      if (err != null) {
        this.logger.error('write error', { team_id: this._teamId, error: err.message });
        this.internalClose();
        this.writeFlushing = false;
        return;
      }

      if (this.writeQueue.length > 0) {
        // More messages pending — continue flush via microtask
        queueMicrotask(() => this.flushWriteQueue());
      } else {
        this.writeFlushing = false;
      }
    });
  }
}

// ---------------------------------------------------------------------------
// toBuffer — normalise ws.RawData to Buffer
// ---------------------------------------------------------------------------

/**
 * Converts any ws.RawData variant to a single Buffer.
 * ws delivers messages as Buffer, ArrayBuffer, or Buffer[].
 */
function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  // ArrayBuffer or ArrayBufferView
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  // SharedArrayBuffer
  return Buffer.from(data as ArrayBuffer);
}
