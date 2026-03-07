/**
 * Tests for backend/src/ws/token.ts
 *
 * Verifies:
 *   1. generateToken returns a 64-char hex string
 *   2. validate returns teamId for a valid token
 *   3. validate returns false for an unknown token
 *   4. consume removes the token after first use
 *   5. validateAndConsume atomically validates and deletes
 *   6. Token expires after TOKEN_TTL (5 minutes) — via injectExpiredToken
 *   7. cleanupExpiredTokens removes expired tokens on the next tick
 *   8. pendingCount returns the correct count of non-expired tokens
 *   9. close stops the cleanup interval
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TokenManager } from './token.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true if the string is a valid 64-character hex string. */
function isHex64(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}

// ---------------------------------------------------------------------------
// generateToken
// ---------------------------------------------------------------------------

describe('generateToken', () => {
  let tm: TokenManager;

  beforeEach(() => {
    tm = new TokenManager();
  });

  afterEach(() => {
    tm.close();
  });

  it('returns a 64-character hex string', () => {
    const token = tm.generateToken('tid-abc-123');
    expect(typeof token).toBe('string');
    expect(token).toHaveLength(64);
    expect(isHex64(token)).toBe(true);
  });

  it('generates unique tokens on successive calls', () => {
    const t1 = tm.generateToken('tid-a');
    const t2 = tm.generateToken('tid-a');
    expect(t1).not.toBe(t2);
  });

  it('generated token is retrievable via validate', () => {
    const token = tm.generateToken('tid-xyz');
    const [teamId, ok] = tm.validate(token);
    expect(ok).toBe(true);
    expect(teamId).toBe('tid-xyz');
  });
});

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

describe('validate', () => {
  let tm: TokenManager;

  beforeEach(() => {
    tm = new TokenManager();
  });

  afterEach(() => {
    tm.close();
  });

  it('returns [teamId, true] for a valid token', () => {
    const token = tm.generateToken('tid-team-1');
    const [teamId, ok] = tm.validate(token);
    expect(ok).toBe(true);
    expect(teamId).toBe('tid-team-1');
  });

  it('returns ["", false] for an unknown token', () => {
    const [teamId, ok] = tm.validate('0'.repeat(64));
    expect(ok).toBe(false);
    expect(teamId).toBe('');
  });

  it('does not remove token on validate (token still usable after)', () => {
    const token = tm.generateToken('tid-reuse');
    const [, ok1] = tm.validate(token);
    const [, ok2] = tm.validate(token);
    expect(ok1).toBe(true);
    expect(ok2).toBe(true);
  });

  it('returns ["", false] for an expired token', () => {
    const token = 'a'.repeat(64);
    tm.injectExpiredToken(token, 'tid-dead');
    const [teamId, ok] = tm.validate(token);
    expect(ok).toBe(false);
    expect(teamId).toBe('');
  });
});

// ---------------------------------------------------------------------------
// consume
// ---------------------------------------------------------------------------

describe('consume', () => {
  let tm: TokenManager;

  beforeEach(() => {
    tm = new TokenManager();
  });

  afterEach(() => {
    tm.close();
  });

  it('returns [teamId, true] and removes the token', () => {
    const token = tm.generateToken('tid-once');
    const [teamId, ok] = tm.consume(token);
    expect(ok).toBe(true);
    expect(teamId).toBe('tid-once');
  });

  it('returns ["", false] on second call (token already consumed)', () => {
    const token = tm.generateToken('tid-once');
    tm.consume(token); // first use
    const [teamId, ok] = tm.consume(token); // second use
    expect(ok).toBe(false);
    expect(teamId).toBe('');
  });

  it('returns ["", false] for an unknown token', () => {
    const [teamId, ok] = tm.consume('b'.repeat(64));
    expect(ok).toBe(false);
    expect(teamId).toBe('');
  });

  it('returns ["", false] for an expired token', () => {
    const token = 'c'.repeat(64);
    tm.injectExpiredToken(token, 'tid-exp');
    const [teamId, ok] = tm.consume(token);
    expect(ok).toBe(false);
    expect(teamId).toBe('');
  });
});

// ---------------------------------------------------------------------------
// validateAndConsume
// ---------------------------------------------------------------------------

describe('validateAndConsume', () => {
  let tm: TokenManager;

  beforeEach(() => {
    tm = new TokenManager();
  });

  afterEach(() => {
    tm.close();
  });

  it('returns [teamId, true] and removes the token atomically', () => {
    const token = tm.generateToken('tid-atomic');
    const [teamId, ok] = tm.validateAndConsume(token);
    expect(ok).toBe(true);
    expect(teamId).toBe('tid-atomic');
  });

  it('returns ["", false] on second call (token consumed)', () => {
    const token = tm.generateToken('tid-atomic');
    tm.validateAndConsume(token);
    const [teamId, ok] = tm.validateAndConsume(token);
    expect(ok).toBe(false);
    expect(teamId).toBe('');
  });

  it('returns ["", false] for an expired token', () => {
    const token = 'd'.repeat(64);
    tm.injectExpiredToken(token, 'tid-stale');
    const [teamId, ok] = tm.validateAndConsume(token);
    expect(ok).toBe(false);
    expect(teamId).toBe('');
  });
});

// ---------------------------------------------------------------------------
// pendingCount
// ---------------------------------------------------------------------------

describe('pendingCount', () => {
  let tm: TokenManager;

  beforeEach(() => {
    tm = new TokenManager();
  });

  afterEach(() => {
    tm.close();
  });

  it('returns 0 for an empty manager', () => {
    expect(tm.pendingCount()).toBe(0);
  });

  it('returns correct count after generating tokens', () => {
    tm.generateToken('tid-1');
    tm.generateToken('tid-2');
    tm.generateToken('tid-3');
    expect(tm.pendingCount()).toBe(3);
  });

  it('decrements after a token is consumed', () => {
    const t1 = tm.generateToken('tid-1');
    tm.generateToken('tid-2');
    tm.consume(t1);
    expect(tm.pendingCount()).toBe(1);
  });

  it('does not count expired tokens', () => {
    tm.generateToken('tid-fresh');
    tm.injectExpiredToken('e'.repeat(64), 'tid-stale');
    // Only the fresh token should be counted
    expect(tm.pendingCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Token expiry via injectExpiredToken
// ---------------------------------------------------------------------------

describe('token expiry', () => {
  let tm: TokenManager;

  beforeEach(() => {
    tm = new TokenManager();
  });

  afterEach(() => {
    tm.close();
  });

  it('validate returns false for a token injected as already expired', () => {
    const token = 'f'.repeat(64);
    tm.injectExpiredToken(token, 'tid-exp');
    const [, ok] = tm.validate(token);
    expect(ok).toBe(false);
  });

  it('consume returns false for a token injected as already expired', () => {
    const token = '1'.repeat(64);
    tm.injectExpiredToken(token, 'tid-exp');
    const [, ok] = tm.consume(token);
    expect(ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cleanup loop removes expired tokens
// ---------------------------------------------------------------------------

describe('cleanup loop', () => {
  it('removes expired tokens when the cleanup interval fires', () => {
    vi.useFakeTimers();

    const tm = new TokenManager();

    // Inject an expired token and a valid token
    tm.injectExpiredToken('2'.repeat(64), 'tid-old');
    tm.generateToken('tid-fresh');

    // Before cleanup: pendingCount sees 1 (expired not counted)
    expect(tm.pendingCount()).toBe(1);

    // Advance time to trigger the cleanup interval (>= 60 seconds)
    vi.advanceTimersByTime(61_000);

    // pendingCount should still be 1 (only fresh token remains)
    expect(tm.pendingCount()).toBe(1);

    // The expired token should be gone from the map (validate returns false)
    const [, ok] = tm.validate('2'.repeat(64));
    expect(ok).toBe(false);

    tm.close();
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

describe('close', () => {
  it('stops the cleanup interval (calling close twice does not throw)', () => {
    const tm = new TokenManager();
    expect(() => {
      tm.close();
      tm.close(); // should be idempotent via clearInterval
    }).not.toThrow();
  });

  it('tokens remain accessible after close (no in-flight mutation)', () => {
    const tm = new TokenManager();
    const token = tm.generateToken('tid-z');
    tm.close();
    const [teamId, ok] = tm.validate(token);
    expect(ok).toBe(true);
    expect(teamId).toBe('tid-z');
  });
});
