/**
 * OpenHive Backend - WebSocket One-Time Token Manager
 *
 * Generates cryptographically random one-time tokens for WebSocket
 * authentication. Tokens are:
 *   - 32 bytes of entropy, hex-encoded to 64 characters
 *   - Consumed on first use (validate-then-delete)
 *   - Expired after TOKEN_TTL_MS (5 minutes)
 *   - Cleaned up by a background interval every CLEANUP_INTERVAL_MS (60 seconds)
 */

import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of random bytes per token (results in a 64-char hex string). */
const TOKEN_BYTES = 32;

/** Token time-to-live in milliseconds (5 minutes). */
const TOKEN_TTL_MS = 5 * 60 * 1000;

/** How often the cleanup loop removes expired tokens (60 seconds). */
const CLEANUP_INTERVAL_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Holds a pending token's associated team and creation time. */
interface TokenEntry {
  teamId: string;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// TokenManager
// ---------------------------------------------------------------------------

/**
 * Generates and validates one-time tokens for WebSocket authentication.
 * Tokens are stored in-memory and consumed on first use.
 * Tokens expire after TOKEN_TTL_MS even if not consumed.
 */
export class TokenManager {
  private readonly tokens: Map<string, TokenEntry> = new Map();
  private readonly cleanupInterval: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredTokens();
    }, CLEANUP_INTERVAL_MS);

    // Allow the Node.js process to exit even if the interval is still running.
    if (typeof this.cleanupInterval.unref === 'function') {
      this.cleanupInterval.unref();
    }
  }

  /**
   * Generates a cryptographically random one-time token associated with the
   * given team ID. The token is TOKEN_BYTES bytes, hex-encoded (64 chars).
   * Tokens expire after TOKEN_TTL_MS.
   */
  generateToken(teamId: string): string {
    const buf = randomBytes(TOKEN_BYTES);
    const token = buf.toString('hex');
    this.tokens.set(token, { teamId, createdAt: new Date() });
    return token;
  }

  /**
   * Checks if a token is valid without consuming it.
   * Returns [teamId, true] if valid and not expired.
   * Returns ['', false] if the token is unknown or expired.
   */
  validate(token: string): [string, boolean] {
    const entry = this.tokens.get(token);
    if (entry === undefined) {
      return ['', false];
    }

    if (this.isExpired(entry.createdAt)) {
      this.tokens.delete(token);
      return ['', false];
    }

    return [entry.teamId, true];
  }

  /**
   * Validates and removes a token in one operation.
   * Returns [teamId, true] if valid; deletes the token.
   * Returns ['', false] if the token is unknown or expired.
   */
  consume(token: string): [string, boolean] {
    const entry = this.tokens.get(token);
    if (entry === undefined) {
      return ['', false];
    }

    if (this.isExpired(entry.createdAt)) {
      this.tokens.delete(token);
      return ['', false];
    }

    this.tokens.delete(token);
    return [entry.teamId, true];
  }

  /**
   * Atomically validates and consumes a token.
   * Equivalent to validate() followed by consume() but in a single operation.
   * Returns [teamId, true] if valid; deletes the token.
   * Returns ['', false] if the token is unknown or expired.
   */
  validateAndConsume(token: string): [string, boolean] {
    return this.consume(token);
  }

  /**
   * Returns the number of unexpired, unused tokens.
   * Useful for testing and monitoring.
   */
  pendingCount(): number {
    let count = 0;
    for (const entry of this.tokens.values()) {
      if (!this.isExpired(entry.createdAt)) {
        count++;
      }
    }
    return count;
  }

  /**
   * Stops the background cleanup interval.
   * Call this when the TokenManager is no longer needed.
   */
  close(): void {
    clearInterval(this.cleanupInterval);
  }

  /**
   * Inserts an already-expired token into the manager.
   * FOR TESTING ONLY — do not call from production code.
   */
  injectExpiredToken(token: string, teamId: string): void {
    const expiredAt = new Date(Date.now() - 2 * TOKEN_TTL_MS);
    this.tokens.set(token, { teamId, createdAt: expiredAt });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Returns true if the token created at `createdAt` has exceeded TOKEN_TTL_MS. */
  private isExpired(createdAt: Date): boolean {
    return Date.now() - createdAt.getTime() > TOKEN_TTL_MS;
  }

  /** Removes all tokens older than TOKEN_TTL_MS from the map. */
  private cleanupExpiredTokens(): void {
    for (const [token, entry] of this.tokens.entries()) {
      if (this.isExpired(entry.createdAt)) {
        this.tokens.delete(token);
      }
    }
  }
}
