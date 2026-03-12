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
});
