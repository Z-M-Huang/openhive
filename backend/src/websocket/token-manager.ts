/**
 * WebSocket authentication token manager.
 *
 * Manages two distinct token types:
 *
 * **One-time tokens** (via {@link generate} / {@link validate}):
 * - Used for initial container authentication during WS upgrade.
 * - Single-use: consumed atomically on first successful validate call.
 * - TTL: 5 minutes (configurable).
 *
 * **Session tokens** (via {@link generateSession} / {@link validateSession}):
 * - Used for reconnect authentication after initial handshake.
 * - Reusable: survive successful validation (not consumed).
 * - TID-bound and TTL-checked on every validate call.
 * - Stored in a separate internal Map from one-time tokens.
 *
 * **Token format:**
 * - 32 bytes from crypto.randomBytes, hex-encoded (64 characters).
 * - Bound to a team identifier (TID) at generation time.
 *
 * **Security properties (NFR10):**
 * - Generation: crypto.randomBytes (CSPRNG) for unpredictable tokens.
 * - Comparison: crypto.timingSafeEqual to prevent timing side-channels.
 * - Single-use: validate-then-delete atomically consumes one-time tokens.
 * - TTL: 5-minute expiry (configurable via constructor), checked for both types.
 * - Cleanup: periodic sweep removes expired tokens from both maps.
 *
 * **Lifecycle (one-time):**
 * 1. Root generates a token for a team via {@link generate}.
 * 2. Token is passed to the child container (e.g., via env var or container_init).
 * 3. Child connects to WS hub with the token in the query string.
 * 4. Hub calls {@link validate} which atomically checks and deletes the token.
 * 5. If valid and not expired, the upgrade proceeds. Otherwise, 401.
 *
 * **Lifecycle (session):**
 * 1. Root generates a session token via {@link generateSession} after initial auth.
 * 2. Session token is delivered to the container via `container_init` message.
 * 3. On reconnect, container authenticates with the session token.
 * 4. Hub calls {@link validateSession}: valid if TID matches and not expired/revoked.
 * 5. Token is NOT consumed — container may reconnect multiple times.
 *
 * @remarks
 * - One-time storage: Map<token, { tid, createdAt }> (_tokens).
 * - Session storage: Map<token, { tid, createdAt }> (_sessions, separate Map).
 * - Cleanup interval sweeps both maps; call {@link stopCleanup} on shutdown.
 * - Token-to-TID binding is enforced: a token generated for team A cannot authenticate team B.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { TokenManager } from '../domain/interfaces.js';

/**
 * Token entry stored in the internal registry.
 * Associates a token with its bound team and creation timestamp.
 */
interface TokenEntry {
  /** Team identifier this token is bound to. */
  tid: string;

  /** Timestamp (ms since epoch) when the token was created. */
  createdAt: number;
}

/**
 * Configuration options for the token manager.
 */
export interface TokenManagerConfig {
  /**
   * Token time-to-live in milliseconds.
   * Tokens older than this are considered expired and rejected during validation.
   * @default 300000 (5 minutes)
   */
  ttlMs?: number;
}

/**
 * Implementation of one-time WebSocket authentication token management.
 *
 * Tokens are 64-character hex strings (32 bytes from crypto.randomBytes).
 * Each token is bound to a TID and is single-use: {@link validate} atomically
 * checks validity and deletes the token on success.
 *
 * **NFR10 compliance:**
 * - crypto.randomBytes for generation (CSPRNG).
 * - crypto.timingSafeEqual for constant-time comparison.
 * - Single-use validate-then-delete prevents replay attacks.
 *
 * @example
 * ```ts
 * const manager = new TokenManagerImpl({ ttlMs: 300_000 });
 * manager.startCleanup(60_000);
 *
 * const token = manager.generate('tid-abc-123');
 * // Pass token to child container...
 *
 * const isValid = manager.validate(token, 'tid-abc-123');
 * // true on first call, false on subsequent calls (single-use)
 *
 * manager.stopCleanup();
 * ```
 */
export class TokenManagerImpl implements TokenManager {
  /**
   * One-time token registry.
   * Maps hex-encoded token string to its bound team and creation time.
   * Entries are removed on validate (single-use) or by the cleanup sweep.
   */
  private readonly _tokens: Map<string, TokenEntry> = new Map();

  /**
   * Session token registry (separate from one-time tokens).
   * Session tokens are reusable: they are NOT consumed on validateSession.
   * They are removed by revokeSession, revokeSessionsForTid, or the cleanup sweep.
   */
  private readonly _sessions: Map<string, TokenEntry> = new Map();

  /**
   * Token TTL in milliseconds. Defaults to 5 minutes (300,000 ms).
   * Applied to both one-time tokens and session tokens.
   */
  private readonly _ttlMs: number;

  /**
   * Handle for the periodic cleanup interval timer.
   * Set by {@link startCleanup}, cleared by {@link stopCleanup}.
   */
  private _cleanupTimer: ReturnType<typeof setInterval> | undefined;

  constructor(config?: TokenManagerConfig) {
    this._ttlMs = config?.ttlMs ?? 300_000;
  }

  // -------------------------------------------------------------------------
  // Token generation
  // -------------------------------------------------------------------------

  /**
   * Generates a new one-time authentication token for a team.
   *
   * Creates 32 random bytes via crypto.randomBytes (CSPRNG) and hex-encodes
   * them to produce a 64-character token string. The token is stored in the
   * internal registry bound to the given TID with the current timestamp.
   *
   * @param tid - Team identifier the token is bound to.
   * @returns A 64-character hex string token.
   */
  generate(tid: string): string {
    const token = randomBytes(32).toString('hex');
    this._tokens.set(token, { tid, createdAt: Date.now() });
    return token;
  }

  // -------------------------------------------------------------------------
  // Token validation
  // -------------------------------------------------------------------------

  /**
   * Validates and consumes a one-time token.
   *
   * Performs constant-time comparison using crypto.timingSafeEqual to prevent
   * timing side-channel attacks. If the token exists, is bound to the given
   * TID, and has not expired (within TTL), it is atomically deleted from the
   * registry and true is returned. Otherwise, returns false.
   *
   * **Single-use semantics:** A valid token is deleted on the first successful
   * validate call. Subsequent calls with the same token return false.
   *
   * @param token - The 64-character hex token string to validate.
   * @param tid - The team identifier the token should be bound to.
   * @returns true if the token is valid, bound to the TID, and not expired; false otherwise.
   */
  validate(token: string, tid: string): boolean {
    const entry = this._tokens.get(token);
    if (!entry) {
      return false;
    }

    // Timing-safe TID comparison to prevent side-channel attacks.
    // Both buffers must be the same length for timingSafeEqual.
    const storedBuf = Buffer.from(entry.tid);
    const providedBuf = Buffer.from(tid);
    if (storedBuf.length !== providedBuf.length || !timingSafeEqual(storedBuf, providedBuf)) {
      // Wrong TID — consume the token to prevent brute-force TID guessing
      this._tokens.delete(token);
      return false;
    }

    // Check TTL expiry
    if (Date.now() - entry.createdAt > this._ttlMs) {
      this._tokens.delete(token);
      return false;
    }

    // Valid — atomic delete-on-success (single-use)
    this._tokens.delete(token);
    return true;
  }

  // -------------------------------------------------------------------------
  // Token revocation
  // -------------------------------------------------------------------------

  /**
   * Revokes a specific token, removing it from the registry.
   *
   * No-op if the token does not exist. Used when a container creation is
   * cancelled or fails before the token is consumed.
   *
   * @param token - The token string to revoke.
   */
  revoke(token: string): void {
    this._tokens.delete(token);
  }

  /**
   * Revokes all tokens, clearing the entire registry.
   *
   * Used during shutdown or emergency security reset. All pending tokens
   * become invalid immediately.
   */
  revokeAll(): void {
    this._tokens.clear();
  }

  // -------------------------------------------------------------------------
  // Cleanup lifecycle
  // -------------------------------------------------------------------------

  /**
   * Starts the periodic cleanup sweep at the given interval.
   *
   * The cleanup sweep iterates all tokens in the registry and removes any
   * whose age (Date.now() - createdAt) exceeds the configured TTL.
   *
   * If cleanup is already running, it is stopped and restarted with the
   * new interval.
   *
   * @param intervalMs - Sweep interval in milliseconds (e.g., 60000 for 60s).
   */
  startCleanup(intervalMs: number): void {
    this.stopCleanup();
    this._cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [token, entry] of this._tokens) {
        if (now - entry.createdAt > this._ttlMs) {
          this._tokens.delete(token);
        }
      }
      for (const [token, entry] of this._sessions) {
        if (now - entry.createdAt > this._ttlMs) {
          this._sessions.delete(token);
        }
      }
    }, intervalMs);
  }

  /**
   * Stops the periodic cleanup sweep.
   *
   * Clears the interval timer. No-op if cleanup is not running.
   * Should be called during graceful shutdown to prevent resource leaks.
   */
  stopCleanup(): void {
    if (this._cleanupTimer !== undefined) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Session token management
  // -------------------------------------------------------------------------

  /**
   * Generates a long-lived session token for reconnect purposes.
   *
   * Session tokens are stored in a separate registry (_sessions) from one-time
   * tokens. They survive successful validateSession calls (reusable), but are
   * still TTL-checked on every validation.
   *
   * @param tid - Team identifier the session token is bound to.
   * @returns A 64-character hex string session token.
   */
  generateSession(tid: string): string {
    const token = randomBytes(32).toString('hex');
    this._sessions.set(token, { tid, createdAt: Date.now() });
    return token;
  }

  /**
   * Validates a session token without consuming it.
   *
   * Unlike one-time tokens, session tokens are NOT deleted on successful
   * validation (reusable). The token must be bound to the given TID and
   * within TTL. Uses crypto.timingSafeEqual for constant-time TID comparison.
   *
   * @param token - Session token to validate.
   * @param tid - Team identifier the token should be bound to.
   * @returns true if the session token is valid, bound to the TID, and not expired.
   */
  validateSession(token: string, tid: string): boolean {
    const entry = this._sessions.get(token);
    if (!entry) {
      return false;
    }

    // Timing-safe TID comparison
    const storedBuf = Buffer.from(entry.tid);
    const providedBuf = Buffer.from(tid);
    if (storedBuf.length !== providedBuf.length || !timingSafeEqual(storedBuf, providedBuf)) {
      return false;
    }

    // Check TTL expiry — expired sessions are removed and rejected
    if (Date.now() - entry.createdAt > this._ttlMs) {
      this._sessions.delete(token);
      return false;
    }

    // Valid and not expired — session token is NOT consumed (reusable)
    return true;
  }

  /**
   * Revokes a single session token.
   *
   * No-op if the token does not exist in the session registry.
   * Does not affect one-time tokens.
   *
   * @param token - The session token string to revoke.
   */
  revokeSession(token: string): void {
    this._sessions.delete(token);
  }

  /**
   * Revokes all tokens (both one-time and session) bound to the given TID.
   *
   * Iterates both the one-time token map (_tokens) and the session token map
   * (_sessions), removing all entries whose tid matches. Used during container
   * restart/stop to invalidate stale auth before issuing new tokens.
   * Idempotent: no-op if no tokens exist for the TID.
   *
   * @param tid - Team identifier whose tokens should be revoked.
   */
  revokeSessionsForTid(tid: string): void {
    for (const [token, entry] of this._tokens) {
      if (entry.tid === tid) {
        this._tokens.delete(token);
      }
    }
    for (const [token, entry] of this._sessions) {
      if (entry.tid === tid) {
        this._sessions.delete(token);
      }
    }
  }
}
