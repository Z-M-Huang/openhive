/**
 * One-time WebSocket authentication token manager.
 *
 * Generates cryptographically secure, single-use tokens for WebSocket
 * upgrade authentication. Each token is bound to a specific team (TID)
 * and expires after a configurable TTL.
 *
 * **Token format:**
 * - 32 bytes from crypto.randomBytes, hex-encoded (64 characters).
 * - Bound to a team identifier (TID) at generation time.
 *
 * **Security properties (NFR10):**
 * - Generation: crypto.randomBytes (CSPRNG) for unpredictable tokens.
 * - Comparison: crypto.timingSafeEqual to prevent timing side-channels.
 * - Single-use: validate-then-delete atomically consumes the token.
 * - TTL: 5-minute expiry (configurable via constructor).
 * - Cleanup: periodic sweep (configurable) removes expired tokens.
 *
 * **Lifecycle:**
 * 1. Root generates a token for a team via {@link generate}.
 * 2. Token is passed to the child container (e.g., via env var or container_init).
 * 3. Child connects to WS hub with the token in the query string.
 * 4. Hub calls {@link validate} which atomically checks and deletes the token.
 * 5. If valid and not expired, the upgrade proceeds. Otherwise, 401.
 *
 * @remarks
 * - Internal storage: Map<token, { tid, createdAt }>.
 * - Cleanup interval is managed via setInterval; call {@link stopCleanup} on shutdown.
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
   * Internal token registry.
   * Maps hex-encoded token string to its bound team and creation time.
   * Entries are removed on validate (single-use) or by the cleanup sweep.
   */
  private readonly _tokens: Map<string, TokenEntry> = new Map();

  /**
   * Token TTL in milliseconds. Defaults to 5 minutes (300,000 ms).
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
}
