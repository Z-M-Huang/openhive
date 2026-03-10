/**
 * Tests for HeartbeatMonitorImpl and convertAgentStatuses.
 *
 * Uses fake timers to control setInterval/setTimeout behaviour.
 * All tests use newHeartbeatMonitorWithIntervals (jitter disabled) so
 * startMonitoring() creates the interval immediately.
 *
 * NOTE: We use vi.advanceTimersByTime() (synchronous) — NOT
 * vi.advanceTimersByTimeAsync() which does not work with bun's vitest.
 * After advancing fake time we flush pending microtasks with repeated
 * `await Promise.resolve()` to ensure async callbacks have run.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  HeartbeatMonitorImpl,
  newHeartbeatMonitor,
  newHeartbeatMonitorWithIntervals,
  convertAgentStatuses,
} from './heartbeat.js';
import type { HeartbeatLogger } from './heartbeat.js';
import type { EventBus } from '../domain/interfaces.js';
import type { Event } from '../domain/types.js';
import { NotFoundError } from '../domain/errors.js';
import type { AgentStatus } from '../ws/messages.js';
import type { AgentHeartbeatStatus } from '../domain/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flushes microtasks by yielding to the event loop several times. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

/** Creates a silent no-op logger for tests. */
function makeLogger(): HeartbeatLogger {
  return {
    debug: () => undefined,
    warn: () => undefined,
  };
}

/** Creates a mock EventBus that records published events. */
function makeEventBus(): EventBus & { published: Event[] } {
  const published: Event[] = [];
  return {
    published,
    publish(event: Event): void {
      published.push(event);
    },
    subscribe: () => 'sub-id',
    filteredSubscribe: () => 'sub-id',
    unsubscribe: () => undefined,
    close: () => undefined,
  };
}

/** Creates sample agent heartbeat statuses. */
function makeAgents(count: number = 2): AgentHeartbeatStatus[] {
  return Array.from({ length: count }, (_, i) => ({
    aid: `aid-00${i + 1}`,
    status: 'idle' as const,
    detail: '',
    elapsed_seconds: 0,
    memory_mb: 100,
  }));
}

// ---------------------------------------------------------------------------
// processHeartbeat — stores status and marks healthy
// ---------------------------------------------------------------------------

describe('processHeartbeat', () => {
  it('stores status and marks healthy', () => {
    const monitor = newHeartbeatMonitorWithIntervals(null, makeLogger(), 30_000, 90_000);
    const agents = makeAgents(2);

    monitor.processHeartbeat('tid-001', agents);

    const status = monitor.getStatus('tid-001');
    expect(status.team_id).toBe('tid-001');
    expect(status.is_healthy).toBe(true);
    expect(status.agents).toHaveLength(2);
    expect(status.last_seen).toBeInstanceOf(Date);
    // last_seen should be close to now
    expect(Date.now() - status.last_seen.getTime()).toBeLessThan(1_000);
  });

  it('overwrites a previous status on repeated heartbeats', () => {
    const monitor = newHeartbeatMonitorWithIntervals(null, makeLogger(), 30_000, 90_000);

    monitor.processHeartbeat('tid-001', makeAgents(1));
    const firstSeen = monitor.getStatus('tid-001').last_seen;

    monitor.processHeartbeat('tid-001', makeAgents(3));

    const status = monitor.getStatus('tid-001');
    expect(status.agents).toHaveLength(3);
    expect(status.is_healthy).toBe(true);
    // last_seen should be >= first call (same millisecond or later)
    expect(status.last_seen.getTime()).toBeGreaterThanOrEqual(firstSeen.getTime());
  });

  it('publishes heartbeat_received event', () => {
    const bus = makeEventBus();
    const monitor = newHeartbeatMonitorWithIntervals(bus, makeLogger(), 30_000, 90_000);
    const agents = makeAgents(1);

    monitor.processHeartbeat('tid-002', agents);

    expect(bus.published).toHaveLength(1);
    const event = bus.published[0];
    expect(event).toBeDefined();
    expect(event!.type).toBe('heartbeat_received');
    if (event!.payload.kind === 'heartbeat_received') {
      expect(event!.payload.team_id).toBe('tid-002');
      expect(event!.payload.status.is_healthy).toBe(true);
    }
  });

  it('does not publish event when eventBus is null', () => {
    // Just verify no error is thrown when eventBus is null.
    const monitor = newHeartbeatMonitorWithIntervals(null, makeLogger(), 30_000, 90_000);
    expect(() => monitor.processHeartbeat('tid-003', makeAgents(1))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// getStatus — returns stored status or throws NotFoundError
// ---------------------------------------------------------------------------

describe('getStatus', () => {
  it('returns stored status', () => {
    const monitor = newHeartbeatMonitorWithIntervals(null, makeLogger(), 30_000, 90_000);
    monitor.processHeartbeat('tid-010', makeAgents(2));

    const status = monitor.getStatus('tid-010');
    expect(status.team_id).toBe('tid-010');
  });

  it('throws NotFoundError for unknown team', () => {
    const monitor = newHeartbeatMonitorWithIntervals(null, makeLogger(), 30_000, 90_000);
    expect(() => monitor.getStatus('tid-unknown')).toThrow(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// getAllStatuses — returns snapshot of all statuses
// ---------------------------------------------------------------------------

describe('getAllStatuses', () => {
  it('returns empty object when no heartbeats received', () => {
    const monitor = newHeartbeatMonitorWithIntervals(null, makeLogger(), 30_000, 90_000);
    expect(monitor.getAllStatuses()).toEqual({});
  });

  it('returns all known statuses', () => {
    const monitor = newHeartbeatMonitorWithIntervals(null, makeLogger(), 30_000, 90_000);
    monitor.processHeartbeat('tid-001', makeAgents(1));
    monitor.processHeartbeat('tid-002', makeAgents(2));

    const all = monitor.getAllStatuses();
    expect(Object.keys(all)).toHaveLength(2);
    expect(all['tid-001']).toBeDefined();
    expect(all['tid-002']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// checkHealth — marks stale containers unhealthy
// ---------------------------------------------------------------------------

describe('checkHealth', () => {
  it('marks stale container unhealthy', () => {
    const monitor = newHeartbeatMonitorWithIntervals(null, makeLogger(), 30_000, 90_000);

    monitor.processHeartbeat('tid-stale', makeAgents(1));
    expect(monitor.getStatus('tid-stale').is_healthy).toBe(true);

    monitor.injectStaleStatus('tid-stale');
    monitor.checkHealth();

    expect(monitor.getStatus('tid-stale').is_healthy).toBe(false);
  });

  it('does not mark fresh container unhealthy', () => {
    const monitor = newHeartbeatMonitorWithIntervals(null, makeLogger(), 30_000, 90_000);

    monitor.processHeartbeat('tid-fresh', makeAgents(1));
    monitor.checkHealth();

    expect(monitor.getStatus('tid-fresh').is_healthy).toBe(true);
  });

  it('publishes container_state_changed event on unhealthy transition', () => {
    const bus = makeEventBus();
    const monitor = newHeartbeatMonitorWithIntervals(bus, makeLogger(), 30_000, 90_000);

    monitor.processHeartbeat('tid-stale2', makeAgents(1));
    bus.published.length = 0; // clear the heartbeat_received event

    monitor.injectStaleStatus('tid-stale2');
    monitor.checkHealth();

    const stateEvents = bus.published.filter((e) => e.type === 'container_state_changed');
    expect(stateEvents).toHaveLength(1);
    const event = stateEvents[0];
    expect(event).toBeDefined();
    if (event!.payload.kind === 'container_state_changed') {
      expect(event!.payload.team_id).toBe('tid-stale2');
      expect(event!.payload.state).toBe('failed');
    }
  });
});

// ---------------------------------------------------------------------------
// onUnhealthy callback — fires for unhealthy containers
// ---------------------------------------------------------------------------

describe('onUnhealthy callback', () => {
  it('fires callback when container becomes unhealthy', () => {
    const monitor = newHeartbeatMonitorWithIntervals(null, makeLogger(), 30_000, 90_000);
    const unhealthyTeams: string[] = [];

    monitor.setOnUnhealthy((teamID) => {
      unhealthyTeams.push(teamID);
    });

    monitor.processHeartbeat('tid-cb', makeAgents(1));
    monitor.injectStaleStatus('tid-cb');
    monitor.checkHealth();

    expect(unhealthyTeams).toEqual(['tid-cb']);
  });

  it('does not fire callback for healthy containers', () => {
    const monitor = newHeartbeatMonitorWithIntervals(null, makeLogger(), 30_000, 90_000);
    const unhealthyTeams: string[] = [];

    monitor.setOnUnhealthy((teamID) => {
      unhealthyTeams.push(teamID);
    });

    monitor.processHeartbeat('tid-healthy', makeAgents(1));
    monitor.checkHealth();

    expect(unhealthyTeams).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Healthy-to-unhealthy transition fires only once
// ---------------------------------------------------------------------------

describe('healthy-to-unhealthy transition fires only once', () => {
  it('callback fires once even if checkHealth is called multiple times', () => {
    const monitor = newHeartbeatMonitorWithIntervals(null, makeLogger(), 30_000, 90_000);
    const calls: string[] = [];

    monitor.setOnUnhealthy((teamID) => calls.push(teamID));

    monitor.processHeartbeat('tid-once', makeAgents(1));
    monitor.injectStaleStatus('tid-once');

    // First check: healthy → unhealthy (callback fires)
    monitor.checkHealth();
    // Second check: already unhealthy (callback must NOT fire again)
    monitor.checkHealth();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('tid-once');
  });
});

// ---------------------------------------------------------------------------
// convertAgentStatuses — maps correctly
// ---------------------------------------------------------------------------

describe('convertAgentStatuses', () => {
  it('maps known status values correctly', () => {
    const wsAgents: AgentStatus[] = [
      { aid: 'aid-001', status: 'idle', elapsed_seconds: 10, memory_mb: 50 },
      { aid: 'aid-002', status: 'busy', detail: 'working', elapsed_seconds: 30, memory_mb: 120 },
      { aid: 'aid-003', status: 'starting', elapsed_seconds: 1, memory_mb: 30 },
    ];

    const result = convertAgentStatuses(wsAgents);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({
      aid: 'aid-001',
      status: 'idle',
      detail: '',
      elapsed_seconds: 10,
      memory_mb: 50,
    });
    expect(result[1]).toEqual({
      aid: 'aid-002',
      status: 'busy',
      detail: 'working',
      elapsed_seconds: 30,
      memory_mb: 120,
    });
    expect(result[2]).toEqual({
      aid: 'aid-003',
      status: 'starting',
      detail: '',
      elapsed_seconds: 1,
      memory_mb: 30,
    });
  });

  it('maps unknown status to error', () => {
    const wsAgents: AgentStatus[] = [
      { aid: 'aid-bad', status: 'unknown_value', elapsed_seconds: 0, memory_mb: 0 },
    ];

    const result = convertAgentStatuses(wsAgents);
    expect(result[0]!.status).toBe('error');
  });

  it('handles all valid AgentStatusType values', () => {
    const validStatuses = ['idle', 'busy', 'starting', 'stopped', 'error'] as const;
    for (const s of validStatuses) {
      const wsAgents: AgentStatus[] = [{ aid: 'aid-x', status: s, elapsed_seconds: 0, memory_mb: 0 }];
      const result = convertAgentStatuses(wsAgents);
      expect(result[0]!.status).toBe(s);
    }
  });

  it('handles empty input', () => {
    const result = convertAgentStatuses([]);
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// startMonitoring — begins interval checking
// ---------------------------------------------------------------------------

describe('startMonitoring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls checkHealth after each interval tick', async () => {
    const monitor = newHeartbeatMonitorWithIntervals(null, makeLogger(), 1_000, 5_000);
    monitor.processHeartbeat('tid-interval', makeAgents(1));

    // Spy on checkHealth to count calls
    const checkHealthSpy = vi.spyOn(monitor, 'checkHealth');

    monitor.startMonitoring();

    // Advance past two intervals
    vi.advanceTimersByTime(2_100);
    await flushMicrotasks();

    expect(checkHealthSpy).toHaveBeenCalledTimes(2);

    monitor.stopMonitoring();
    checkHealthSpy.mockRestore();
  });

  it('is idempotent — multiple calls do not create multiple intervals', async () => {
    const monitor = newHeartbeatMonitorWithIntervals(null, makeLogger(), 1_000, 5_000);
    const checkHealthSpy = vi.spyOn(monitor, 'checkHealth');

    monitor.startMonitoring();
    monitor.startMonitoring(); // second call must be a no-op
    monitor.startMonitoring(); // third call must be a no-op

    vi.advanceTimersByTime(2_100);
    await flushMicrotasks();

    // Only 2 ticks from one interval, not 6 from three intervals
    expect(checkHealthSpy).toHaveBeenCalledTimes(2);

    monitor.stopMonitoring();
    checkHealthSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// stopMonitoring — clears interval
// ---------------------------------------------------------------------------

describe('stopMonitoring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops checkHealth from being called after stop', async () => {
    const monitor = newHeartbeatMonitorWithIntervals(null, makeLogger(), 1_000, 5_000);
    const checkHealthSpy = vi.spyOn(monitor, 'checkHealth');

    monitor.startMonitoring();

    // Let two ticks run
    vi.advanceTimersByTime(2_100);
    await flushMicrotasks();
    expect(checkHealthSpy).toHaveBeenCalledTimes(2);

    monitor.stopMonitoring();

    // Advance more time — no further calls expected
    vi.advanceTimersByTime(5_000);
    await flushMicrotasks();
    expect(checkHealthSpy).toHaveBeenCalledTimes(2);

    checkHealthSpy.mockRestore();
  });

  it('is idempotent — multiple stop calls are safe', () => {
    const monitor = newHeartbeatMonitorWithIntervals(null, makeLogger(), 1_000, 5_000);
    monitor.startMonitoring();
    monitor.stopMonitoring();
    expect(() => monitor.stopMonitoring()).not.toThrow();
    expect(() => monitor.stopMonitoring()).not.toThrow();
  });

  it('startMonitoring after stop is a no-op', async () => {
    const monitor = newHeartbeatMonitorWithIntervals(null, makeLogger(), 1_000, 5_000);
    const checkHealthSpy = vi.spyOn(monitor, 'checkHealth');

    monitor.startMonitoring();
    monitor.stopMonitoring();

    // Try to restart — should not create a new interval
    monitor.startMonitoring();
    vi.advanceTimersByTime(2_100);
    await flushMicrotasks();

    // No calls because both the original interval and the re-start are stopped/no-op
    expect(checkHealthSpy).toHaveBeenCalledTimes(0);

    checkHealthSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// newHeartbeatMonitor — factory function
// ---------------------------------------------------------------------------

describe('newHeartbeatMonitor', () => {
  it('creates a monitor that implements HeartbeatMonitor interface', () => {
    const monitor = newHeartbeatMonitor(null, makeLogger());
    expect(monitor).toBeInstanceOf(HeartbeatMonitorImpl);
    expect(typeof monitor.processHeartbeat).toBe('function');
    expect(typeof monitor.getStatus).toBe('function');
    expect(typeof monitor.getAllStatuses).toBe('function');
    expect(typeof monitor.setOnUnhealthy).toBe('function');
    expect(typeof monitor.startMonitoring).toBe('function');
    expect(typeof monitor.stopMonitoring).toBe('function');
  });
});
