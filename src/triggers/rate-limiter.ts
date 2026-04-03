/**
 * Trigger rate limiter -- sliding-window rate limiting per source.
 *
 * Tracks timestamps of recent events in memory and rejects
 * events that exceed the configured threshold within the window.
 */

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly retryAfterMs?: number;
}

export class TriggerRateLimiter {
  private readonly windows = new Map<string, number[]>();

  constructor(
    private readonly maxEvents: number,
    private readonly windowMs: number,
  ) {}

  check(source: string): RateLimitResult {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    let timestamps = this.windows.get(source);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(source, timestamps);
    }

    // Prune expired timestamps
    const pruned = timestamps.filter((t) => t > cutoff);
    this.windows.set(source, pruned);

    if (pruned.length >= this.maxEvents) {
      const oldest = pruned[0];
      const retryAfterMs = oldest + this.windowMs - now;
      return { allowed: false, retryAfterMs };
    }

    pruned.push(now);
    return { allowed: true };
  }
}
