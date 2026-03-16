/**
 * Unit tests for ProactiveScheduler.
 *
 * Covers AC-D1 (per-agent and team-level proactive_interval_minutes) and
 * AC-D4 (daily dispatchedChecks pruning via pruneOldChecks).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProactiveScheduler } from './proactive-scheduler.js';
import { AgentStatus } from '../domain/enums.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockLogger() {
  return {
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(),
    error: vi.fn(), audit: vi.fn(), log: vi.fn(), flush: vi.fn(), stop: vi.fn(),
  };
}

function createMockHealthMonitor(defaultStatus: AgentStatus = AgentStatus.Idle) {
  return {
    recordHeartbeat: vi.fn(),
    getHealth: vi.fn(),
    getAgentHealth: vi.fn().mockReturnValue(defaultStatus),
    getAllHealth: vi.fn(),
    getStuckAgents: vi.fn().mockReturnValue([]),
    checkTimeouts: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// ProactiveScheduler construction helpers
// ---------------------------------------------------------------------------

function makeScheduler(overrides?: {
  healthStatus?: AgentStatus;
  dispatcher?: (agentAid: string, checkId: string) => Promise<void>;
}) {
  const healthMonitor = createMockHealthMonitor(overrides?.healthStatus ?? AgentStatus.Idle);
  const logger = createMockLogger();
  const dispatcher = overrides?.dispatcher ?? vi.fn().mockResolvedValue(undefined);

  const scheduler = new ProactiveScheduler({ healthMonitor, logger, dispatcher });
  return { scheduler, healthMonitor, logger, dispatcher };
}

// ---------------------------------------------------------------------------
// start() / stop() / pruning
// ---------------------------------------------------------------------------

describe('ProactiveScheduler - start/stop/prune', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('start() begins the daily prune timer and stop() clears it', () => {
    const { scheduler } = makeScheduler();

    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

    scheduler.start();
    // One interval for the prune timer should have been registered
    const pruneTimerCalls = setIntervalSpy.mock.calls.filter(
      (call) => call[1] === 24 * 60 * 60 * 1000
    );
    expect(pruneTimerCalls.length).toBe(1);

    scheduler.stop();
    expect(clearIntervalSpy).toHaveBeenCalled();

    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  it('start() is idempotent — calling twice does not leak timers', () => {
    const { scheduler } = makeScheduler();
    scheduler.start();
    // Second call should clear the old prune timer before starting a new one
    expect(() => scheduler.start()).not.toThrow();
    scheduler.stop();
  });

  it('pruneOldChecks removes entries older than 24h', () => {
    const { scheduler } = makeScheduler();

    // Manually insert a stale entry with a timestamp 25 hours ago
    const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const staleId = `${staleDate.getFullYear()}-${pad(staleDate.getMonth() + 1)}-${pad(staleDate.getDate())}-${pad(staleDate.getHours())}:${pad(staleDate.getMinutes())}-aid-test-abc`;
    scheduler['dispatchedChecks'].add(staleId);
    expect(scheduler['dispatchedChecks'].size).toBe(1);

    // Call pruneOldChecks directly
    scheduler['pruneOldChecks']();

    // The stale entry should have been removed
    expect(scheduler['dispatchedChecks'].size).toBe(0);
  });

  it('pruneOldChecks retains entries younger than 24h', () => {
    const { scheduler } = makeScheduler();

    // Manually insert a recent entry with a timestamp 1 hour ago
    const recentDate = new Date(Date.now() - 1 * 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const recentId = `${recentDate.getFullYear()}-${pad(recentDate.getMonth() + 1)}-${pad(recentDate.getDate())}-${pad(recentDate.getHours())}:${pad(recentDate.getMinutes())}-aid-test-abc`;
    scheduler['dispatchedChecks'].add(recentId);
    expect(scheduler['dispatchedChecks'].size).toBe(1);

    // Call pruneOldChecks directly — entry should be kept
    scheduler['pruneOldChecks']();

    expect(scheduler['dispatchedChecks'].size).toBe(1);
  });

  it('pruneOldChecks is called daily via the prune timer', () => {
    const { scheduler } = makeScheduler();

    // Spy on private pruneOldChecks
    const pruneSpy = vi.spyOn(scheduler as unknown as { pruneOldChecks(): void }, 'pruneOldChecks');

    scheduler.start();

    // Not called yet
    expect(pruneSpy).not.toHaveBeenCalled();

    // Advance exactly 24 hours — prune timer fires once
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(pruneSpy).toHaveBeenCalledTimes(1);

    // Advance another 24 hours — fires again
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(pruneSpy).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it('stop() clears dispatchedChecks and pruneTimer', () => {
    const { scheduler } = makeScheduler();
    scheduler.start();
    scheduler.registerAgent('aid-test-abc', 5);

    // Manually add an entry to dispatchedChecks
    scheduler['dispatchedChecks'].add('2026-01-01-10:00-aid-test-abc');

    scheduler.stop();

    expect(scheduler['dispatchedChecks'].size).toBe(0);
    expect(scheduler['pruneTimer']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// registerAgent — interval enforcement (CON-07, CON-08)
// ---------------------------------------------------------------------------

describe('ProactiveScheduler - registerAgent interval', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('uses default 30-min interval when no intervalMinutes provided', () => {
    const { scheduler } = makeScheduler();
    const setIntervalSpy = vi.spyOn(global, 'setInterval');

    scheduler.registerAgent('aid-agent-abc');

    // Should have registered a timer with 30 min (1800000 ms)
    const agentTimerCall = setIntervalSpy.mock.calls.find(
      (call) => call[1] === 30 * 60 * 1000
    );
    expect(agentTimerCall).toBeDefined();

    setIntervalSpy.mockRestore();
    scheduler.stop();
  });

  it('uses the specified intervalMinutes when provided', () => {
    const { scheduler } = makeScheduler();
    const setIntervalSpy = vi.spyOn(global, 'setInterval');

    scheduler.registerAgent('aid-agent-abc', 15);

    const agentTimerCall = setIntervalSpy.mock.calls.find(
      (call) => call[1] === 15 * 60 * 1000
    );
    expect(agentTimerCall).toBeDefined();

    setIntervalSpy.mockRestore();
    scheduler.stop();
  });

  it('enforces 5-minute minimum interval (CON-07)', () => {
    const { scheduler } = makeScheduler();
    const setIntervalSpy = vi.spyOn(global, 'setInterval');

    // Request 2-minute interval — should be clamped to 5 min
    scheduler.registerAgent('aid-agent-abc', 2);

    const agentTimerCall = setIntervalSpy.mock.calls.find(
      (call) => call[1] === 5 * 60 * 1000
    );
    expect(agentTimerCall).toBeDefined();

    // Should NOT have created a 2-minute timer
    const twoMinTimer = setIntervalSpy.mock.calls.find(
      (call) => call[1] === 2 * 60 * 1000
    );
    expect(twoMinTimer).toBeUndefined();

    setIntervalSpy.mockRestore();
    scheduler.stop();
  });

  it('re-registering an agent clears the previous timer', () => {
    const { scheduler } = makeScheduler();
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

    scheduler.registerAgent('aid-agent-abc', 10);
    expect(scheduler.getRegisteredCount()).toBe(1);

    scheduler.registerAgent('aid-agent-abc', 20); // re-register same agent
    expect(scheduler.getRegisteredCount()).toBe(1); // still 1 registered

    // clearInterval should have been called to remove the old timer
    expect(clearIntervalSpy).toHaveBeenCalled();

    clearIntervalSpy.mockRestore();
    scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// fireCheck — idempotency and dispatch
// ---------------------------------------------------------------------------

describe('ProactiveScheduler - fireCheck', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('dispatches a proactive check when agent is idle', async () => {
    const dispatcher = vi.fn().mockResolvedValue(undefined);
    const { scheduler } = makeScheduler({ healthStatus: AgentStatus.Idle, dispatcher });
    scheduler.registerAgent('aid-test-abc', 5);

    await scheduler.fireCheck('aid-test-abc');

    expect(dispatcher).toHaveBeenCalledTimes(1);
    expect(dispatcher.mock.calls[0][0]).toBe('aid-test-abc');
    // check ID format: YYYY-MM-DD-HH:MM-{aid}
    expect(dispatcher.mock.calls[0][1]).toMatch(/^\d{4}-\d{2}-\d{2}-\d{2}:\d{2}-aid-test-abc$/);

    scheduler.stop();
  });

  it('skips dispatch when agent is not idle', async () => {
    const dispatcher = vi.fn().mockResolvedValue(undefined);
    const { scheduler } = makeScheduler({ healthStatus: AgentStatus.Busy, dispatcher });
    scheduler.registerAgent('aid-test-abc', 5);

    await scheduler.fireCheck('aid-test-abc');

    expect(dispatcher).not.toHaveBeenCalled();

    scheduler.stop();
  });

  it('deduplicates checks within the same minute', async () => {
    const dispatcher = vi.fn().mockResolvedValue(undefined);
    const { scheduler } = makeScheduler({ dispatcher });
    scheduler.registerAgent('aid-test-abc', 5);

    // Fire twice in the same minute — same checkId, second call should be deduped
    await scheduler.fireCheck('aid-test-abc');
    await scheduler.fireCheck('aid-test-abc');

    expect(dispatcher).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });
});
