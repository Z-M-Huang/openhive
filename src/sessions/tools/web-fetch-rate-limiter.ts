/**
 * web_fetch per-domain token bucket rate limiter (ADR-41, Team-Configuration.md).
 *
 * Reads a team's `rate_limit_buckets` configuration and enforces per-domain
 * quotas on outbound web_fetch calls. Every domain has its own token bucket
 * keyed by the exact string under `rate_limit_buckets`. Domains without a
 * configured bucket are allowed unconditionally — the limiter is an allowlist
 * enforcer, not a default-deny gate.
 *
 * Bucket semantics:
 *   - Capacity = `burst` tokens.
 *   - Refill rate = `rps` tokens per second (continuous, not cliff-edge).
 *   - Each successful `consume()` removes one token.
 *   - When empty, reject with retry_after_ms = ceil(1000 / rps).
 *
 * State is kept in-process and scoped to the builder instance — assemble once
 * per team/session so rotated configs take effect on the next assembly.
 */
import type { RateLimitBucket } from '../../domain/types.js';

interface BucketState {
  readonly spec: RateLimitBucket;
  tokens: number;
  lastRefillMs: number;
}

export interface WebFetchRateLimiter {
  consume(domain: string): { ok: true } | { ok: false; retry_after_ms: number };
}

/**
 * Build a domain-keyed token-bucket limiter from a team's `rate_limit_buckets`.
 * Returns undefined when the team has no buckets configured so callers can
 * leave the limiter unset (no rate limiting, no wasted wrapper overhead).
 */
export function buildWebFetchRateLimiter(
  buckets: Readonly<Record<string, RateLimitBucket>> | undefined,
  now: () => number = Date.now,
): WebFetchRateLimiter | undefined {
  if (!buckets || Object.keys(buckets).length === 0) return undefined;

  const state = new Map<string, BucketState>();
  for (const [key, spec] of Object.entries(buckets)) {
    state.set(key, { spec, tokens: spec.burst, lastRefillMs: now() });
  }

  return {
    consume(domain: string): { ok: true } | { ok: false; retry_after_ms: number } {
      const bucket = state.get(domain);
      if (!bucket) return { ok: true };

      // Continuous refill — fractional tokens allowed up to burst capacity.
      const t = now();
      const elapsedMs = Math.max(0, t - bucket.lastRefillMs);
      const refill = (elapsedMs / 1000) * bucket.spec.rps;
      bucket.tokens = Math.min(bucket.spec.burst, bucket.tokens + refill);
      bucket.lastRefillMs = t;

      if (bucket.tokens < 1) {
        const missing = 1 - bucket.tokens;
        const retry_after_ms = Math.ceil((missing / bucket.spec.rps) * 1000);
        return { ok: false, retry_after_ms };
      }

      bucket.tokens -= 1;
      return { ok: true };
    },
  };
}
