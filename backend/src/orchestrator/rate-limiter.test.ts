/**
 * Tests for backend/src/orchestrator/rate-limiter.ts
 *
 * Strategy:
 *   - Verify that actions within the configured limit are allowed.
 *   - Verify that actions exceeding the configured limit are rejected.
 *   - Verify that the sliding window expires after windowMs.
 *   - Verify that different agents are tracked independently.
 *   - Verify that unknown actions (no configured limit) are always allowed.
 *   - Verify that lazy cleanup removes expired entries on check.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import { SlidingWindowRateLimiter } from './rate-limiter.js';
import type { RateLimiter } from '../domain/interfaces.js';

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Interface conformance
// ---------------------------------------------------------------------------

describe('SlidingWindowRateLimiter interface conformance', () => {
  it('satisfies the RateLimiter interface', () => {
    const limiter: RateLimiter = new SlidingWindowRateLimiter();
    expect(typeof limiter.checkRate).toBe('function');
    expect(typeof limiter.recordAction).toBe('function');
    expect(typeof limiter.handleProviderRateLimit).toBe('function');
    expect(typeof limiter.isProviderBackedOff).toBe('function');
  });

  it('checkRate has arity 2', () => {
    const limiter = new SlidingWindowRateLimiter();
    expect(limiter.checkRate.length).toBe(2);
  });

  it('recordAction has arity 2', () => {
    const limiter = new SlidingWindowRateLimiter();
    expect(limiter.recordAction.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Within limit — allowed
// ---------------------------------------------------------------------------

describe('within limit', () => {
  it('allows actions under the configured limit', () => {
    const limiter = new SlidingWindowRateLimiter({
      windowMs: 60_000,
      limits: { create_team: 3 },
    });

    const aid = 'aid-agent-001';
    // Record 2 actions (limit is 3)
    limiter.recordAction(aid, 'create_team');
    limiter.recordAction(aid, 'create_team');

    expect(limiter.checkRate(aid, 'create_team')).toBe(true);
  });

  it('allows exactly at the boundary (count === limit - 1 after records)', () => {
    const limiter = new SlidingWindowRateLimiter({
      windowMs: 60_000,
      limits: { dispatch_task: 2 },
    });

    const aid = 'aid-agent-002';
    limiter.recordAction(aid, 'dispatch_task');

    // 1 recorded, limit is 2 => still under limit
    expect(limiter.checkRate(aid, 'dispatch_task')).toBe(true);
  });

  it('allows the first action with no prior records', () => {
    const limiter = new SlidingWindowRateLimiter({
      windowMs: 60_000,
      limits: { create_team: 5 },
    });

    expect(limiter.checkRate('aid-agent-003', 'create_team')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Over limit — rejected
// ---------------------------------------------------------------------------

describe('over limit', () => {
  it('rejects when count reaches the configured limit', () => {
    const limiter = new SlidingWindowRateLimiter({
      windowMs: 60_000,
      limits: { create_team: 3 },
    });

    const aid = 'aid-agent-004';
    limiter.recordAction(aid, 'create_team');
    limiter.recordAction(aid, 'create_team');
    limiter.recordAction(aid, 'create_team');

    // 3 recorded, limit is 3 => at limit, should reject
    expect(limiter.checkRate(aid, 'create_team')).toBe(false);
  });

  it('rejects when count exceeds the configured limit', () => {
    const limiter = new SlidingWindowRateLimiter({
      windowMs: 60_000,
      limits: { escalate: 2 },
    });

    const aid = 'aid-agent-005';
    limiter.recordAction(aid, 'escalate');
    limiter.recordAction(aid, 'escalate');
    limiter.recordAction(aid, 'escalate');

    // 3 recorded, limit is 2 => over limit
    expect(limiter.checkRate(aid, 'escalate')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Window expiry — resets after windowMs
// ---------------------------------------------------------------------------

describe('window expiry', () => {
  it('resets after windowMs elapses', () => {
    const windowMs = 1000;
    const limiter = new SlidingWindowRateLimiter({
      windowMs,
      limits: { create_team: 2 },
    });

    const aid = 'aid-agent-006';
    const baseTime = 1_000_000;

    // Record 2 actions at baseTime
    vi.spyOn(Date, 'now').mockReturnValue(baseTime);
    limiter.recordAction(aid, 'create_team');
    limiter.recordAction(aid, 'create_team');

    // At baseTime, should be at limit
    expect(limiter.checkRate(aid, 'create_team')).toBe(false);

    // Advance past the window
    vi.spyOn(Date, 'now').mockReturnValue(baseTime + windowMs + 1);

    // After window expiry, should be allowed again
    expect(limiter.checkRate(aid, 'create_team')).toBe(true);
  });

  it('only expires entries older than windowMs (sliding behavior)', () => {
    const windowMs = 1000;
    const limiter = new SlidingWindowRateLimiter({
      windowMs,
      limits: { dispatch_task: 2 },
    });

    const aid = 'aid-agent-007';

    // Record first action at t=0
    vi.spyOn(Date, 'now').mockReturnValue(0);
    limiter.recordAction(aid, 'dispatch_task');

    // Record second action at t=500
    vi.spyOn(Date, 'now').mockReturnValue(500);
    limiter.recordAction(aid, 'dispatch_task');

    // At t=500, at limit
    expect(limiter.checkRate(aid, 'dispatch_task')).toBe(false);

    // At t=1001, first entry expired but second still valid
    vi.spyOn(Date, 'now').mockReturnValue(1001);
    // 1 remaining entry, limit is 2 => allowed
    expect(limiter.checkRate(aid, 'dispatch_task')).toBe(true);

    // Record again at t=1001
    limiter.recordAction(aid, 'dispatch_task');
    // Now 2 entries (t=500 and t=1001), at limit
    expect(limiter.checkRate(aid, 'dispatch_task')).toBe(false);

    // At t=1501, t=500 entry expires
    vi.spyOn(Date, 'now').mockReturnValue(1501);
    expect(limiter.checkRate(aid, 'dispatch_task')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Different agents tracked independently
// ---------------------------------------------------------------------------

describe('independent agent tracking', () => {
  it('tracks different agents independently', () => {
    const limiter = new SlidingWindowRateLimiter({
      windowMs: 60_000,
      limits: { create_team: 2 },
    });

    const agent1 = 'aid-agent-008';
    const agent2 = 'aid-agent-009';

    // Fill agent1 to limit
    limiter.recordAction(agent1, 'create_team');
    limiter.recordAction(agent1, 'create_team');
    expect(limiter.checkRate(agent1, 'create_team')).toBe(false);

    // agent2 should still be allowed
    expect(limiter.checkRate(agent2, 'create_team')).toBe(true);
  });

  it('tracks same agent across different actions independently', () => {
    const limiter = new SlidingWindowRateLimiter({
      windowMs: 60_000,
      limits: { create_team: 1, dispatch_task: 3 },
    });

    const aid = 'aid-agent-010';

    // Fill create_team to limit
    limiter.recordAction(aid, 'create_team');
    expect(limiter.checkRate(aid, 'create_team')).toBe(false);

    // dispatch_task should still be allowed
    expect(limiter.checkRate(aid, 'dispatch_task')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unknown action — allowed (no limit configured = unlimited)
// ---------------------------------------------------------------------------

describe('unknown action', () => {
  it('allows actions with no configured limit', () => {
    const limiter = new SlidingWindowRateLimiter({
      windowMs: 60_000,
      limits: { create_team: 2 },
    });

    const aid = 'aid-agent-011';
    // Record many actions for an unconfigured action
    for (let i = 0; i < 100; i++) {
      limiter.recordAction(aid, 'some_unknown_action');
    }

    // Should always be allowed (no limit for this action)
    expect(limiter.checkRate(aid, 'some_unknown_action')).toBe(true);
  });

  it('does not record timestamps for unknown actions', () => {
    const limiter = new SlidingWindowRateLimiter({
      windowMs: 60_000,
      limits: {},
    });

    const aid = 'aid-agent-012';
    limiter.recordAction(aid, 'no_limit_action');

    // checkRate should return true (no limit) and no internal state created
    expect(limiter.checkRate(aid, 'no_limit_action')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lazy cleanup
// ---------------------------------------------------------------------------

describe('lazy cleanup', () => {
  it('removes expired entries during checkRate', () => {
    const windowMs = 1000;
    const limiter = new SlidingWindowRateLimiter({
      windowMs,
      limits: { create_team: 5 },
    });

    const aid = 'aid-agent-013';

    // Record 3 actions at t=0
    vi.spyOn(Date, 'now').mockReturnValue(0);
    limiter.recordAction(aid, 'create_team');
    limiter.recordAction(aid, 'create_team');
    limiter.recordAction(aid, 'create_team');

    // At t=1001, all 3 should be expired
    vi.spyOn(Date, 'now').mockReturnValue(1001);

    // checkRate triggers lazy cleanup
    expect(limiter.checkRate(aid, 'create_team')).toBe(true);

    // After cleanup, recording new actions should start fresh
    limiter.recordAction(aid, 'create_team');
    limiter.recordAction(aid, 'create_team');
    // 2 fresh entries, limit is 5 => allowed
    expect(limiter.checkRate(aid, 'create_team')).toBe(true);
  });

  it('cleans up entries even when result is still allowed', () => {
    const windowMs = 500;
    const limiter = new SlidingWindowRateLimiter({
      windowMs,
      limits: { dispatch_task: 10 },
    });

    const aid = 'aid-agent-014';

    // Record 5 actions at t=0
    vi.spyOn(Date, 'now').mockReturnValue(0);
    for (let i = 0; i < 5; i++) {
      limiter.recordAction(aid, 'dispatch_task');
    }

    // At t=501, all expired. Record 1 new action.
    vi.spyOn(Date, 'now').mockReturnValue(501);
    limiter.recordAction(aid, 'dispatch_task');

    // checkRate prunes expired entries; only 1 active entry remains
    expect(limiter.checkRate(aid, 'dispatch_task')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

describe('default configuration', () => {
  it('uses default limits when no config provided', () => {
    const limiter = new SlidingWindowRateLimiter();

    const aid = 'aid-agent-015';

    // Default create_team limit is 5
    for (let i = 0; i < 5; i++) {
      limiter.recordAction(aid, 'create_team');
    }
    expect(limiter.checkRate(aid, 'create_team')).toBe(false);

    // But 4 should be within limit
    const limiter2 = new SlidingWindowRateLimiter();
    const aid2 = 'aid-agent-016';
    for (let i = 0; i < 4; i++) {
      limiter2.recordAction(aid2, 'create_team');
    }
    expect(limiter2.checkRate(aid2, 'create_team')).toBe(true);
  });

  it('uses default dispatch_task limit of 30', () => {
    const limiter = new SlidingWindowRateLimiter();
    const aid = 'aid-agent-017';

    for (let i = 0; i < 30; i++) {
      limiter.recordAction(aid, 'dispatch_task');
    }
    expect(limiter.checkRate(aid, 'dispatch_task')).toBe(false);
  });

  it('uses default dispatch_subtask limit of 30', () => {
    const limiter = new SlidingWindowRateLimiter();
    const aid = 'aid-agent-018';

    for (let i = 0; i < 30; i++) {
      limiter.recordAction(aid, 'dispatch_subtask');
    }
    expect(limiter.checkRate(aid, 'dispatch_subtask')).toBe(false);
  });

  it('uses default escalate limit of 10', () => {
    const limiter = new SlidingWindowRateLimiter();
    const aid = 'aid-agent-019';

    for (let i = 0; i < 10; i++) {
      limiter.recordAction(aid, 'escalate');
    }
    expect(limiter.checkRate(aid, 'escalate')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Provider circuit breaking
// ---------------------------------------------------------------------------

describe('provider circuit breaking', () => {
  it('isProviderBackedOff returns false for unknown providers', () => {
    const limiter = new SlidingWindowRateLimiter();
    expect(limiter.isProviderBackedOff('unknown-provider')).toBe(false);
  });

  it('handleProviderRateLimit sets backoff', () => {
    const limiter = new SlidingWindowRateLimiter();
    limiter.handleProviderRateLimit('anthropic', 5000);
    expect(limiter.isProviderBackedOff('anthropic')).toBe(true);
  });

  it('isProviderBackedOff returns false after backoff expires', () => {
    const limiter = new SlidingWindowRateLimiter();
    // Set a backoff that already expired
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1000)   // handleProviderRateLimit reads Date.now()
      .mockReturnValueOnce(7000);  // isProviderBackedOff reads Date.now()
    limiter.handleProviderRateLimit('anthropic', 5000);  // expires at 6000
    expect(limiter.isProviderBackedOff('anthropic')).toBe(false);
  });

  it('different providers are tracked independently', () => {
    const limiter = new SlidingWindowRateLimiter();
    limiter.handleProviderRateLimit('anthropic', 60000);
    expect(limiter.isProviderBackedOff('anthropic')).toBe(true);
    expect(limiter.isProviderBackedOff('openai')).toBe(false);
  });

  it('auto-clears expired backoff on check', () => {
    const limiter = new SlidingWindowRateLimiter();
    const base = Date.now();
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(base)         // handleProviderRateLimit
      .mockReturnValueOnce(base + 100)   // first check: still backed off
      .mockReturnValueOnce(base + 6000); // second check: expired
    limiter.handleProviderRateLimit('anthropic', 5000);
    expect(limiter.isProviderBackedOff('anthropic')).toBe(true);
    expect(limiter.isProviderBackedOff('anthropic')).toBe(false);
  });
});
