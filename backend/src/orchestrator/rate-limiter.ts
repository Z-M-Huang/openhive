/**
 * OpenHive Backend - Sliding Window Rate Limiter
 *
 * Implements RateLimiter — guards tool invocations against runaway agents
 * by enforcing per-action rate limits using a sliding window algorithm.
 *
 * Key design choices:
 *   - In-memory Map<string, number[]> keyed by '{agentAID}:{action}'.
 *   - Lazy cleanup: expired timestamps are pruned on each checkRate() call.
 *   - Actions without a configured limit are allowed unconditionally and
 *     do not create internal state (recordAction is a no-op for them).
 *   - Uses setter injection matching existing setOrgChart pattern.
 */

import type { RateLimiter } from '../domain/interfaces.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Configuration for the sliding window rate limiter. */
export interface RateLimiterConfig {
  /** Sliding window duration in milliseconds. Default: 60000 (60 seconds). */
  windowMs: number;
  /** Maximum invocations per action within the window. Unlisted actions are unlimited. */
  limits: Record<string, number>;
}

/** Default rate limiter configuration. */
const DEFAULT_CONFIG: RateLimiterConfig = {
  windowMs: 60_000,
  limits: {
    create_team: 5,
    dispatch_task: 30,
    dispatch_subtask: 30,
    escalate: 10,
  },
};

// ---------------------------------------------------------------------------
// SlidingWindowRateLimiter
// ---------------------------------------------------------------------------

/**
 * In-memory sliding window rate limiter.
 *
 * Each (agent, action) pair maintains an array of timestamps. On checkRate(),
 * expired timestamps (older than windowMs) are pruned, and the remaining
 * count is compared against the configured limit for that action.
 *
 * Actions with no configured limit are always allowed — recordAction() is
 * a no-op and checkRate() returns true without creating internal state.
 */
export class SlidingWindowRateLimiter implements RateLimiter {
  private readonly windowMs: number;
  private readonly limits: Record<string, number>;
  private readonly timestamps: Map<string, number[]> = new Map();
  /** Provider name → backoff-until timestamp (ms). */
  private readonly providerBackoff: Map<string, number> = new Map();

  constructor(config?: Partial<RateLimiterConfig>) {
    this.windowMs = config?.windowMs ?? DEFAULT_CONFIG.windowMs;
    this.limits = config?.limits ?? { ...DEFAULT_CONFIG.limits };
  }

  /**
   * Check whether the agent is within the rate limit for the given action.
   *
   * Returns true if the action is allowed (under limit or no limit configured).
   * Returns false if the action would exceed the configured limit.
   *
   * Side-effect: prunes expired timestamps (lazy cleanup).
   */
  checkRate(agentAID: string, action: string): boolean {
    const limit = this.limits[action];
    if (limit === undefined) {
      return true;
    }

    const key = `${agentAID}:${action}`;
    const entries = this.timestamps.get(key);
    if (entries === undefined) {
      return true;
    }

    // Lazy cleanup: remove expired timestamps
    const cutoff = Date.now() - this.windowMs;
    const pruned = entries.filter((ts) => ts > cutoff);

    if (pruned.length === 0) {
      this.timestamps.delete(key);
    } else {
      this.timestamps.set(key, pruned);
    }

    return pruned.length < limit;
  }

  /**
   * Record that the agent performed the given action at the current time.
   *
   * No-op for actions without a configured limit (avoids unbounded memory growth).
   */
  recordAction(agentAID: string, action: string): void {
    if (this.limits[action] === undefined) {
      return;
    }

    const key = `${agentAID}:${action}`;
    const entries = this.timestamps.get(key);
    if (entries === undefined) {
      this.timestamps.set(key, [Date.now()]);
    } else {
      entries.push(Date.now());
    }
  }

  /**
   * Handle a provider 429 response by applying a circuit breaker backoff.
   * During the backoff period, isProviderBackedOff() returns true.
   */
  handleProviderRateLimit(providerName: string, retryAfterMs: number): void {
    this.providerBackoff.set(providerName, Date.now() + retryAfterMs);
  }

  /**
   * Check if a provider is currently in backoff due to a prior 429 response.
   * Auto-clears expired backoff entries.
   */
  isProviderBackedOff(providerName: string): boolean {
    const until = this.providerBackoff.get(providerName);
    if (until === undefined) {
      return false;
    }
    if (Date.now() >= until) {
      this.providerBackoff.delete(providerName);
      return false;
    }
    return true;
  }
}
