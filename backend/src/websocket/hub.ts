/**
 * WebSocket hub managing all container connections (root-only).
 *
 * Maintains a connection registry (Map<string, WSConnection>), routes messages
 * based on the org chart, enforces direction constraints, and provides
 * per-connection write queues and rate limiting.
 *
 * // INV-02: All inter-container messages flow through root WS hub.
 * // INV-03: No direct container-to-container communication.
 *
 * Hub-and-spoke topology — root routes every message. Containers never
 * communicate directly with each other; all traffic passes through this hub.
 *
 * @remarks
 * - Connection registry: Map<string, ConnectionEntry> keyed by TID.
 * - Per-connection write queue: capacity 256 messages, FIFO drain.
 * - Rate limiter: 100 messages/sec with burst capacity of 100.
 * - Direction enforcement via protocol.validateDirection().
 */

import type { WSHub, WSConnection, WSMessage } from '../domain/interfaces.js';
import { NotFoundError, RateLimitedError, ValidationError } from '../domain/errors.js';
import { validateDirection } from './protocol.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum messages buffered in a per-connection write queue. */
const WRITE_QUEUE_CAP = 256;

/** Maximum tokens in the rate-limiter bucket. */
const RATE_LIMIT_MAX_TOKENS = 100;

/** Tokens refilled per second. */
const RATE_LIMIT_REFILL_PER_SEC = 100;

/** TID used to identify the root container. */
const ROOT_TID = 'root';

// ---------------------------------------------------------------------------
// Token Bucket Rate Limiter
// ---------------------------------------------------------------------------

class TokenBucket {
  private _tokens: number;
  private _lastRefill: number;
  private readonly _maxTokens: number;
  private readonly _refillPerSec: number;

  constructor(maxTokens: number, refillPerSec: number) {
    this._maxTokens = maxTokens;
    this._refillPerSec = refillPerSec;
    this._tokens = maxTokens;
    this._lastRefill = Date.now();
  }

  tryConsume(): boolean {
    this._refill();
    if (this._tokens >= 1) {
      this._tokens -= 1;
      return true;
    }
    return false;
  }

  private _refill(): void {
    const now = Date.now();
    const elapsed = (now - this._lastRefill) / 1000;
    if (elapsed <= 0) return;
    this._tokens = Math.min(this._maxTokens, this._tokens + elapsed * this._refillPerSec);
    this._lastRefill = now;
  }
}

// ---------------------------------------------------------------------------
// Connection Entry
// ---------------------------------------------------------------------------

interface ConnectionEntry {
  connection: WSConnection;
  writeQueue: WSMessage[];
  rateLimiter: TokenBucket;
  draining: boolean;
}

// ---------------------------------------------------------------------------
// WSHubImpl
// ---------------------------------------------------------------------------

/**
 * Hub-and-spoke WebSocket hub implementing the WSHub interface.
 *
 * // INV-02: All messages through root WS hub.
 * // INV-03: No container-to-container communication.
 */
export class WSHubImpl implements WSHub {
  private readonly _entries: Map<string, ConnectionEntry> = new Map();

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  /**
   * Registers a new container connection in the hub.
   *
   * If a connection for this TID already exists, the old connection is closed
   * before the new one is registered. Initializes a per-connection write queue
   * (capacity 256) and rate limiter (100 msgs/sec, burst 100).
   */
  register(tid: string, connection: WSConnection): void {
    const existing = this._entries.get(tid);
    if (existing) {
      existing.connection.close(1001, 'Replaced by new connection');
      this._entries.delete(tid);
    }
    this._entries.set(tid, {
      connection,
      writeQueue: [],
      rateLimiter: new TokenBucket(RATE_LIMIT_MAX_TOKENS, RATE_LIMIT_REFILL_PER_SEC),
      draining: false,
    });
  }

  /**
   * Removes a container connection from the hub.
   *
   * Drains any pending write queue messages before removing.
   */
  unregister(tid: string): void {
    const entry = this._entries.get(tid);
    if (!entry) return;
    // Drain remaining messages synchronously
    this._drainSync(entry);
    this._entries.delete(tid);
  }

  // -------------------------------------------------------------------------
  // WSHub interface — upgrade handling
  // -------------------------------------------------------------------------

  /**
   * Handles an HTTP upgrade request for a WebSocket connection.
   *
   * Delegation point — the real upgrade logic lives in WSServer.
   * This is a no-op; WSServer calls its own handleUpgrade directly.
   */
  handleUpgrade(_request: unknown, _socket: unknown, _head: unknown): void {
    // No-op: WSServer handles upgrades directly and calls register() on this hub.
  }

  // -------------------------------------------------------------------------
  // Message routing
  // -------------------------------------------------------------------------

  /**
   * Routes a message to its destination container.
   *
   * INV-02: All messages must go through root.
   * INV-03: No direct container-to-container communication.
   *
   * Either sourceTid or targetTid must be 'root'.
   * Direction validation ensures the message type matches the flow direction.
   */
  route(sourceTid: string, targetTid: string, message: WSMessage): void {
    // INV-02/INV-03: one side must be root
    if (sourceTid !== ROOT_TID && targetTid !== ROOT_TID) {
      throw new ValidationError(
        `INV-03 violation: direct container-to-container routing from "${sourceTid}" to "${targetTid}" is not allowed`
      );
    }

    // Determine direction based on which side is root
    const direction = sourceTid === ROOT_TID ? 'root_to_container' : 'container_to_root';

    // Validate message type matches direction
    if (!validateDirection(message.type, direction)) {
      throw new ValidationError(
        `Message type "${message.type}" is not valid for direction "${direction}"`
      );
    }

    // Enqueue for the target (if target is root, we don't route to a connection — root handles internally)
    if (targetTid === ROOT_TID) {
      // Container-to-root: root processes internally, no connection to enqueue on
      return;
    }

    const entry = this._entries.get(targetTid);
    if (!entry) {
      throw new NotFoundError(`No connection for TID "${targetTid}"`);
    }

    this._enqueue(entry, message);
  }

  /**
   * Sends a message to a specific connected container identified by TID.
   *
   * Checks rate limiter before enqueuing.
   */
  send(tid: string, message: WSMessage): void {
    const entry = this._entries.get(tid);
    if (!entry) {
      throw new NotFoundError(`No connection for TID "${tid}"`);
    }

    if (!entry.rateLimiter.tryConsume()) {
      throw new RateLimitedError(`Rate limit exceeded for TID "${tid}"`);
    }

    this._enqueue(entry, message);
  }

  /**
   * Broadcasts a message to all connected containers.
   */
  broadcast(message: WSMessage): void {
    for (const [, entry] of this._entries) {
      this._enqueue(entry, message);
    }
  }

  // -------------------------------------------------------------------------
  // Connection queries
  // -------------------------------------------------------------------------

  isConnected(tid: string): boolean {
    const entry = this._entries.get(tid);
    if (!entry) return false;
    return entry.connection.isAlive();
  }

  getConnectedTeams(): string[] {
    return Array.from(this._entries.keys());
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async close(): Promise<void> {
    for (const [tid, entry] of this._entries) {
      this._drainSync(entry);
      entry.connection.close(1001, 'Hub shutting down');
      this._entries.delete(tid);
    }
  }

  // -------------------------------------------------------------------------
  // Internal: write queue management
  // -------------------------------------------------------------------------

  /**
   * Enqueues a message in the entry's write queue and schedules a drain.
   * If the queue exceeds capacity, closes the connection.
   */
  private _enqueue(entry: ConnectionEntry, message: WSMessage): void {
    entry.writeQueue.push(message);

    if (entry.writeQueue.length > WRITE_QUEUE_CAP) {
      // Slow consumer — close the connection (policy violation)
      entry.connection.close(1008, 'Write queue overflow');
      entry.writeQueue.length = 0;
      return;
    }

    this._scheduleDrain(entry);
  }

  /** Schedules an async drain cycle via queueMicrotask. */
  private _scheduleDrain(entry: ConnectionEntry): void {
    if (entry.draining) return;
    entry.draining = true;
    queueMicrotask(() => {
      this._drain(entry);
      entry.draining = false;
    });
  }

  /** Drains the write queue FIFO, sending each message via the connection. */
  private _drain(entry: ConnectionEntry): void {
    while (entry.writeQueue.length > 0) {
      const msg = entry.writeQueue.shift()!;
      try {
        entry.connection.send(msg);
      } catch {
        // Connection may have been closed; stop draining
        break;
      }
    }
  }

  /** Synchronously drains the write queue (used during unregister/close). */
  private _drainSync(entry: ConnectionEntry): void {
    while (entry.writeQueue.length > 0) {
      const msg = entry.writeQueue.shift()!;
      try {
        entry.connection.send(msg);
      } catch {
        break;
      }
    }
  }
}
