import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TokenManagerImpl } from './token-manager.js';

describe('TokenManagerImpl', () => {
  let manager: TokenManagerImpl;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new TokenManagerImpl();
  });

  afterEach(() => {
    manager.stopCleanup();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Token format
  // -------------------------------------------------------------------------

  it('generates a 64-character hex token', () => {
    const token = manager.generate('tid-abc-123');
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates unique tokens', () => {
    const t1 = manager.generate('tid-abc-123');
    const t2 = manager.generate('tid-abc-123');
    expect(t1).not.toBe(t2);
  });

  // -------------------------------------------------------------------------
  // Generate -> validate round-trip
  // -------------------------------------------------------------------------

  it('validate returns true for a freshly generated token with matching TID', () => {
    const token = manager.generate('tid-abc-123');
    expect(manager.validate(token, 'tid-abc-123')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Single-use
  // -------------------------------------------------------------------------

  it('second validate of the same token returns false (single-use)', () => {
    const token = manager.generate('tid-abc-123');
    expect(manager.validate(token, 'tid-abc-123')).toBe(true);
    expect(manager.validate(token, 'tid-abc-123')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // TTL expiry
  // -------------------------------------------------------------------------

  it('validate returns false after TTL expires', () => {
    const token = manager.generate('tid-abc-123');
    // Advance past default 5-minute TTL
    vi.advanceTimersByTime(300_001);
    expect(manager.validate(token, 'tid-abc-123')).toBe(false);
  });

  it('validate returns true just before TTL expires', () => {
    const token = manager.generate('tid-abc-123');
    vi.advanceTimersByTime(299_999);
    expect(manager.validate(token, 'tid-abc-123')).toBe(true);
  });

  it('respects custom TTL from constructor config', () => {
    const custom = new TokenManagerImpl({ ttlMs: 10_000 });
    const token = custom.generate('tid-abc-123');
    vi.advanceTimersByTime(10_001);
    expect(custom.validate(token, 'tid-abc-123')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Wrong TID
  // -------------------------------------------------------------------------

  it('validate returns false for wrong TID', () => {
    const token = manager.generate('tid-abc-123');
    expect(manager.validate(token, 'tid-xyz-999')).toBe(false);
  });

  it('token is consumed after wrong TID attempt', () => {
    const token = manager.generate('tid-abc-123');
    manager.validate(token, 'tid-xyz-999');
    // Even the correct TID should fail now — token was consumed
    expect(manager.validate(token, 'tid-abc-123')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Unknown token
  // -------------------------------------------------------------------------

  it('validate returns false for unknown token', () => {
    expect(manager.validate('deadbeef'.repeat(8), 'tid-abc-123')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // revoke
  // -------------------------------------------------------------------------

  it('revoke makes a token invalid', () => {
    const token = manager.generate('tid-abc-123');
    manager.revoke(token);
    expect(manager.validate(token, 'tid-abc-123')).toBe(false);
  });

  it('revoke is a no-op for unknown tokens', () => {
    // Should not throw
    manager.revoke('nonexistent');
  });

  // -------------------------------------------------------------------------
  // revokeAll
  // -------------------------------------------------------------------------

  it('revokeAll invalidates all tokens', () => {
    const t1 = manager.generate('tid-abc-123');
    const t2 = manager.generate('tid-def-456');
    manager.revokeAll();
    expect(manager.validate(t1, 'tid-abc-123')).toBe(false);
    expect(manager.validate(t2, 'tid-def-456')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Cleanup sweep
  // -------------------------------------------------------------------------

  it('cleanup sweep removes expired tokens', () => {
    const t1 = manager.generate('tid-abc-123');
    const t2 = manager.generate('tid-def-456');

    // Advance past TTL
    vi.advanceTimersByTime(300_001);

    // Start cleanup with a short interval
    manager.startCleanup(1_000);

    // Trigger the cleanup interval
    vi.advanceTimersByTime(1_000);

    // Both tokens should be gone
    expect(manager.validate(t1, 'tid-abc-123')).toBe(false);
    expect(manager.validate(t2, 'tid-def-456')).toBe(false);
  });

  it('cleanup sweep keeps non-expired tokens', () => {
    const token = manager.generate('tid-abc-123');

    manager.startCleanup(1_000);
    // Trigger cleanup but token is still fresh
    vi.advanceTimersByTime(1_000);

    expect(manager.validate(token, 'tid-abc-123')).toBe(true);
  });

  it('startCleanup restarts if already running', () => {
    manager.startCleanup(1_000);
    // Should not throw, should replace the existing timer
    manager.startCleanup(2_000);
    manager.stopCleanup();
  });

  // -------------------------------------------------------------------------
  // stopCleanup
  // -------------------------------------------------------------------------

  it('stopCleanup is a no-op if cleanup is not running', () => {
    // Should not throw
    manager.stopCleanup();
  });

  // -------------------------------------------------------------------------
  // generateSession / validateSession
  // -------------------------------------------------------------------------

  it('generateSession returns a 64-character hex token', () => {
    const token = manager.generateSession('tid-abc-123');
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generateSession produces unique tokens', () => {
    const t1 = manager.generateSession('tid-abc-123');
    const t2 = manager.generateSession('tid-abc-123');
    expect(t1).not.toBe(t2);
  });

  it('validateSession returns true for a freshly generated session token', () => {
    const token = manager.generateSession('tid-abc-123');
    expect(manager.validateSession(token, 'tid-abc-123')).toBe(true);
  });

  it('validateSession is reusable — second call still returns true', () => {
    const token = manager.generateSession('tid-abc-123');
    expect(manager.validateSession(token, 'tid-abc-123')).toBe(true);
    expect(manager.validateSession(token, 'tid-abc-123')).toBe(true);
  });

  it('validateSession returns false for wrong TID', () => {
    const token = manager.generateSession('tid-abc-123');
    expect(manager.validateSession(token, 'tid-xyz-999')).toBe(false);
  });

  it('validateSession with wrong TID does NOT consume the session token', () => {
    const token = manager.generateSession('tid-abc-123');
    manager.validateSession(token, 'tid-xyz-999');
    // Session token still valid for correct TID
    expect(manager.validateSession(token, 'tid-abc-123')).toBe(true);
  });

  it('validateSession returns false after TTL expires', () => {
    const token = manager.generateSession('tid-abc-123');
    vi.advanceTimersByTime(300_001);
    expect(manager.validateSession(token, 'tid-abc-123')).toBe(false);
  });

  it('validateSession returns true just before TTL expires', () => {
    const token = manager.generateSession('tid-abc-123');
    vi.advanceTimersByTime(299_999);
    expect(manager.validateSession(token, 'tid-abc-123')).toBe(true);
  });

  it('validateSession returns false for unknown session token', () => {
    expect(manager.validateSession('deadbeef'.repeat(8), 'tid-abc-123')).toBe(false);
  });

  it('one-time token and session token do not share storage', () => {
    // Generating a session token should NOT allow it to pass validate (one-time check)
    const sessionToken = manager.generateSession('tid-abc-123');
    expect(manager.validate(sessionToken, 'tid-abc-123')).toBe(false);

    // Generating a one-time token should NOT allow it to pass validateSession
    const oneTimeToken = manager.generate('tid-abc-123');
    expect(manager.validateSession(oneTimeToken, 'tid-abc-123')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // revokeSession
  // -------------------------------------------------------------------------

  it('revokeSession makes a session token invalid', () => {
    const token = manager.generateSession('tid-abc-123');
    manager.revokeSession(token);
    expect(manager.validateSession(token, 'tid-abc-123')).toBe(false);
  });

  it('revokeSession is a no-op for unknown tokens', () => {
    // Should not throw
    manager.revokeSession('nonexistent');
  });

  it('revokeSession does not affect one-time tokens', () => {
    const oneTime = manager.generate('tid-abc-123');
    const session = manager.generateSession('tid-abc-123');
    manager.revokeSession(session);
    // One-time token should still be valid
    expect(manager.validate(oneTime, 'tid-abc-123')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // revokeSessionsForTid
  // -------------------------------------------------------------------------

  it('revokeSessionsForTid removes session tokens for the given TID', () => {
    const token = manager.generateSession('tid-abc-123');
    manager.revokeSessionsForTid('tid-abc-123');
    expect(manager.validateSession(token, 'tid-abc-123')).toBe(false);
  });

  it('revokeSessionsForTid removes one-time tokens for the given TID', () => {
    const token = manager.generate('tid-abc-123');
    manager.revokeSessionsForTid('tid-abc-123');
    expect(manager.validate(token, 'tid-abc-123')).toBe(false);
  });

  it('revokeSessionsForTid does not affect tokens for other TIDs', () => {
    const otherSession = manager.generateSession('tid-other-456');
    const otherOneTime = manager.generate('tid-other-456');
    manager.generateSession('tid-abc-123');
    manager.generate('tid-abc-123');

    manager.revokeSessionsForTid('tid-abc-123');

    expect(manager.validateSession(otherSession, 'tid-other-456')).toBe(true);
    expect(manager.validate(otherOneTime, 'tid-other-456')).toBe(true);
  });

  it('revokeSessionsForTid revokes all session tokens for the TID (multiple)', () => {
    const s1 = manager.generateSession('tid-abc-123');
    const s2 = manager.generateSession('tid-abc-123');
    manager.revokeSessionsForTid('tid-abc-123');
    expect(manager.validateSession(s1, 'tid-abc-123')).toBe(false);
    expect(manager.validateSession(s2, 'tid-abc-123')).toBe(false);
  });

  it('revokeSessionsForTid is idempotent', () => {
    manager.generateSession('tid-abc-123');
    manager.revokeSessionsForTid('tid-abc-123');
    // Second call should not throw
    manager.revokeSessionsForTid('tid-abc-123');
  });

  // -------------------------------------------------------------------------
  // Cleanup sweep covers session tokens
  // -------------------------------------------------------------------------

  it('cleanup sweep removes expired session tokens', () => {
    const token = manager.generateSession('tid-abc-123');

    vi.advanceTimersByTime(300_001);
    manager.startCleanup(1_000);
    vi.advanceTimersByTime(1_000);

    expect(manager.validateSession(token, 'tid-abc-123')).toBe(false);
  });

  it('cleanup sweep keeps non-expired session tokens', () => {
    const token = manager.generateSession('tid-abc-123');

    manager.startCleanup(1_000);
    vi.advanceTimersByTime(1_000); // sweep runs but token is fresh

    expect(manager.validateSession(token, 'tid-abc-123')).toBe(true);
  });
});
