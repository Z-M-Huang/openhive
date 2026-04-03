/**
 * UT-16: Rate Limiter
 *
 * Tests: allows within threshold, blocks when exceeded, resets after window
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { TriggerRateLimiter } from './rate-limiter.js';

// ── UT-16: Rate Limiter ──────────────────────────────────────────────────

describe('UT-16: Rate Limiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows events within threshold', () => {
    const limiter = new TriggerRateLimiter(3, 60_000);

    expect(limiter.check('source-a').allowed).toBe(true);
    expect(limiter.check('source-a').allowed).toBe(true);
    expect(limiter.check('source-a').allowed).toBe(true);
  });

  it('blocks when threshold exceeded', () => {
    const limiter = new TriggerRateLimiter(2, 60_000);

    limiter.check('source-a');
    limiter.check('source-a');

    const result = limiter.check('source-a');
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('resets after window elapses', () => {
    const limiter = new TriggerRateLimiter(2, 10_000);

    limiter.check('source-a');
    limiter.check('source-a');

    expect(limiter.check('source-a').allowed).toBe(false);

    vi.advanceTimersByTime(10_001);

    expect(limiter.check('source-a').allowed).toBe(true);
  });

  it('tracks sources independently', () => {
    const limiter = new TriggerRateLimiter(1, 60_000);

    limiter.check('source-a');
    expect(limiter.check('source-a').allowed).toBe(false);
    expect(limiter.check('source-b').allowed).toBe(true);
  });

  it('sliding window allows after oldest event expires', () => {
    const limiter = new TriggerRateLimiter(2, 10_000);

    limiter.check('s');
    vi.advanceTimersByTime(5000);
    limiter.check('s');

    // At 5s: both within window, next should be blocked
    expect(limiter.check('s').allowed).toBe(false);

    // Advance 5001ms: first event falls out of window
    vi.advanceTimersByTime(5001);
    expect(limiter.check('s').allowed).toBe(true);
  });
});
