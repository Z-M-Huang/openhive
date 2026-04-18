/**
 * Unit tests for buildWebFetchRateLimiter (ADR-41).
 *
 * Contract covered:
 *  - No buckets configured → factory returns undefined.
 *  - Unconfigured domain → consume() allows unconditionally.
 *  - Configured domain → bucket drains with each consume(); rejects with
 *    retry_after_ms = ceil((missing / rps) * 1000) when empty.
 *  - Continuous refill → tokens accumulate fractionally over time, capped at burst.
 *  - Buckets are isolated per key.
 */

import { describe, it, expect } from 'vitest';
import { buildWebFetchRateLimiter } from './web-fetch-rate-limiter.js';

describe('buildWebFetchRateLimiter', () => {
  it('returns undefined when buckets config is missing', () => {
    expect(buildWebFetchRateLimiter(undefined)).toBeUndefined();
  });

  it('returns undefined when buckets config is empty', () => {
    expect(buildWebFetchRateLimiter({})).toBeUndefined();
  });

  it('allows unconditionally for domains without a configured bucket', () => {
    const limiter = buildWebFetchRateLimiter({
      'api.example.com': { rps: 1, burst: 1 },
    });
    expect(limiter).toBeDefined();
    // Different domain — passes through.
    const r = limiter!.consume('other.example.com');
    expect(r.ok).toBe(true);
  });

  it('drains burst capacity and then rejects with retry_after_ms', () => {
    const now = 1_000_000;
    const limiter = buildWebFetchRateLimiter(
      { 'api.example.com': { rps: 2, burst: 3 } },
      () => now,
    );

    // Three allowed consumes exhaust the burst.
    expect(limiter!.consume('api.example.com')).toEqual({ ok: true });
    expect(limiter!.consume('api.example.com')).toEqual({ ok: true });
    expect(limiter!.consume('api.example.com')).toEqual({ ok: true });

    // Fourth call with no elapsed time is rejected.
    const rejected = limiter!.consume('api.example.com');
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      // missing = 1 token, rps = 2 → retry_after_ms = ceil(1/2 * 1000) = 500ms
      expect(rejected.retry_after_ms).toBe(500);
    }
  });

  it('refills tokens continuously over elapsed time up to burst capacity', () => {
    let now = 0;
    const limiter = buildWebFetchRateLimiter(
      { 'api.example.com': { rps: 10, burst: 2 } },
      () => now,
    );

    // Drain the bucket.
    expect(limiter!.consume('api.example.com').ok).toBe(true);
    expect(limiter!.consume('api.example.com').ok).toBe(true);
    expect(limiter!.consume('api.example.com').ok).toBe(false);

    // 100ms later → 1 token refilled at rps=10.
    now = 100;
    expect(limiter!.consume('api.example.com').ok).toBe(true);
    expect(limiter!.consume('api.example.com').ok).toBe(false);

    // Advance way beyond what capacity allows — tokens cap at burst (2).
    now = 10_000;
    expect(limiter!.consume('api.example.com').ok).toBe(true);
    expect(limiter!.consume('api.example.com').ok).toBe(true);
    expect(limiter!.consume('api.example.com').ok).toBe(false);
  });

  it('isolates buckets keyed by different domain names', () => {
    const now = 0;
    const limiter = buildWebFetchRateLimiter(
      {
        'a.example.com': { rps: 1, burst: 1 },
        'b.example.com': { rps: 1, burst: 1 },
      },
      () => now,
    );

    expect(limiter!.consume('a.example.com').ok).toBe(true);
    expect(limiter!.consume('a.example.com').ok).toBe(false);

    // b's bucket is untouched.
    expect(limiter!.consume('b.example.com').ok).toBe(true);
    expect(limiter!.consume('b.example.com').ok).toBe(false);
  });

  it('rounds retry_after_ms up to the next whole millisecond', () => {
    const now = 0;
    const limiter = buildWebFetchRateLimiter(
      { 'api.example.com': { rps: 3, burst: 1 } },
      () => now,
    );

    expect(limiter!.consume('api.example.com').ok).toBe(true);
    const r = limiter!.consume('api.example.com');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // missing=1, rps=3 → 1/3 * 1000 = 333.33ms → ceil = 334ms
      expect(r.retry_after_ms).toBe(334);
    }
  });
});
