import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HealthMonitorImpl } from './health.js';
import { ContainerHealth, AgentStatus } from '../domain/index.js';
import type { EventBus, BusEvent } from '../domain/index.js';

function createMockEventBus(): EventBus & { events: BusEvent[] } {
  const events: BusEvent[] = [];
  return {
    events,
    publish(event: BusEvent): void {
      events.push(event);
    },
    subscribe: vi.fn().mockReturnValue('sub-1'),
    filteredSubscribe: vi.fn().mockReturnValue('sub-2'),
    unsubscribe: vi.fn(),
    close: vi.fn(),
  };
}

describe('HealthMonitorImpl', () => {
  let monitor: HealthMonitorImpl;
  let bus: ReturnType<typeof createMockEventBus>;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = createMockEventBus();
    monitor = new HealthMonitorImpl(bus);
  });

  afterEach(() => {
    monitor.stop();
    vi.useRealTimers();
  });

  describe('recordHeartbeat()', () => {
    it('sets state to running and updates timestamp', () => {
      monitor.recordHeartbeat('tid-test-001', [
        { aid: 'aid-agent-001', status: AgentStatus.Idle, detail: 'waiting' },
      ]);

      expect(monitor.getHealth('tid-test-001')).toBe(ContainerHealth.Running);
    });

    it('updates agent statuses', () => {
      monitor.recordHeartbeat('tid-test-001', [
        { aid: 'aid-agent-001', status: AgentStatus.Busy, detail: 'working' },
        { aid: 'aid-agent-002', status: AgentStatus.Idle, detail: 'idle' },
      ]);

      expect(monitor.getAgentHealth('aid-agent-001')).toBe(AgentStatus.Busy);
      expect(monitor.getAgentHealth('aid-agent-002')).toBe(AgentStatus.Idle);
    });
  });

  describe('health state transitions', () => {
    it('returns starting for unknown containers', () => {
      expect(monitor.getHealth('tid-unknown-001')).toBe(ContainerHealth.Starting);
    });

    it('transitions to degraded after 30s', () => {
      monitor.recordHeartbeat('tid-test-001', []);
      vi.advanceTimersByTime(30_000);
      expect(monitor.getHealth('tid-test-001')).toBe(ContainerHealth.Degraded);
    });

    it('transitions to unhealthy after 60s', () => {
      monitor.recordHeartbeat('tid-test-001', []);
      vi.advanceTimersByTime(60_000);
      expect(monitor.getHealth('tid-test-001')).toBe(ContainerHealth.Unhealthy);
    });

    it('transitions to unreachable after 90s', () => {
      monitor.recordHeartbeat('tid-test-001', []);
      vi.advanceTimersByTime(90_000);
      expect(monitor.getHealth('tid-test-001')).toBe(ContainerHealth.Unreachable);
    });

    it('recovers to running on heartbeat during degraded', () => {
      monitor.recordHeartbeat('tid-test-001', []);
      vi.advanceTimersByTime(35_000);
      expect(monitor.getHealth('tid-test-001')).toBe(ContainerHealth.Degraded);

      monitor.recordHeartbeat('tid-test-001', []);
      expect(monitor.getHealth('tid-test-001')).toBe(ContainerHealth.Running);
    });
  });

  describe('recovery events', () => {
    it('publishes health.recovered when heartbeat arrives in degraded state', () => {
      monitor.recordHeartbeat('tid-test-001', []);

      // Advance to degraded and run checkTimeouts to update stored state
      vi.advanceTimersByTime(35_000);
      monitor.start();
      // The start() sets a 30s interval — trigger first check manually
      // by advancing just enough for the interval to fire
      // Actually, we need the stored state to be degraded. Let's use checkTimeouts indirectly.
      // The stored state was 'running' after recordHeartbeat. We need checkTimeouts to update it.
      // start() + advanceTimersByTime(30_000) will trigger checkTimeouts.
      vi.advanceTimersByTime(30_000);
      monitor.stop();

      // Clear previous events
      bus.events.length = 0;

      // Now send heartbeat — should publish recovery
      monitor.recordHeartbeat('tid-test-001', []);

      const recovery = bus.events.find(e => e.type === 'health.recovered');
      expect(recovery).toBeDefined();
      expect(recovery!.data.tid).toBe('tid-test-001');
    });

    it('does not publish health.recovered on first heartbeat (from starting)', () => {
      monitor.recordHeartbeat('tid-test-001', []);
      const recovery = bus.events.find(e => e.type === 'health.recovered');
      expect(recovery).toBeUndefined();
    });
  });

  describe('getAgentHealth()', () => {
    it('returns undefined for unknown agents', () => {
      expect(monitor.getAgentHealth('aid-unknown-001')).toBeUndefined();
    });

    it('finds agent across containers', () => {
      monitor.recordHeartbeat('tid-test-001', [
        { aid: 'aid-agent-001', status: AgentStatus.Busy, detail: 'task-1' },
      ]);
      monitor.recordHeartbeat('tid-test-002', [
        { aid: 'aid-agent-002', status: AgentStatus.Idle, detail: '' },
      ]);

      expect(monitor.getAgentHealth('aid-agent-002')).toBe(AgentStatus.Idle);
    });
  });

  describe('getAllHealth()', () => {
    it('returns health for all tracked containers', () => {
      monitor.recordHeartbeat('tid-test-001', []);
      monitor.recordHeartbeat('tid-test-002', []);
      vi.advanceTimersByTime(35_000);

      const all = monitor.getAllHealth();
      expect(all.size).toBe(2);
      expect(all.get('tid-test-001')).toBe(ContainerHealth.Degraded);
      expect(all.get('tid-test-002')).toBe(ContainerHealth.Degraded);
    });

    it('returns empty map when no containers tracked', () => {
      expect(monitor.getAllHealth().size).toBe(0);
    });
  });

  describe('getStuckAgents()', () => {
    it('detects agents busy longer than timeout', () => {
      monitor.recordHeartbeat('tid-test-001', [
        { aid: 'aid-agent-001', status: AgentStatus.Busy, detail: 'processing' },
      ]);

      vi.advanceTimersByTime(31 * 60 * 1000); // 31 minutes

      // Re-report same busy status to keep agent tracked but not reset statusSince
      // (statusSince only resets when status changes)

      const stuck = monitor.getStuckAgents(30 * 60 * 1000); // 30 min timeout
      expect(stuck).toContain('aid-agent-001');
    });

    it('does not flag agents busy for less than timeout', () => {
      monitor.recordHeartbeat('tid-test-001', [
        { aid: 'aid-agent-001', status: AgentStatus.Busy, detail: 'processing' },
      ]);

      vi.advanceTimersByTime(10 * 60 * 1000); // 10 minutes

      const stuck = monitor.getStuckAgents(30 * 60 * 1000);
      expect(stuck).toHaveLength(0);
    });

    it('does not flag idle agents', () => {
      monitor.recordHeartbeat('tid-test-001', [
        { aid: 'aid-agent-001', status: AgentStatus.Idle, detail: '' },
      ]);

      vi.advanceTimersByTime(60 * 60 * 1000); // 1 hour

      const stuck = monitor.getStuckAgents(30 * 60 * 1000);
      expect(stuck).toHaveLength(0);
    });
  });

  describe('start() / stop()', () => {
    it('start() creates periodic timer', () => {
      monitor.recordHeartbeat('tid-test-001', []);

      monitor.start();
      vi.advanceTimersByTime(65_000); // past degraded + one check interval

      // checkTimeouts should have run and published state_changed
      const changed = bus.events.find(e => e.type === 'health.state_changed');
      expect(changed).toBeDefined();
    });

    it('start() is idempotent', () => {
      monitor.start();
      monitor.start(); // should not throw or create duplicate timers
      monitor.stop();
    });

    it('stop() clears the timer', () => {
      monitor.recordHeartbeat('tid-test-001', []);
      monitor.start();
      monitor.stop();

      bus.events.length = 0;
      vi.advanceTimersByTime(120_000);

      // No state_changed events because timer was stopped
      const changed = bus.events.find(e => e.type === 'health.state_changed');
      expect(changed).toBeUndefined();
    });

    it('stop() is idempotent', () => {
      monitor.stop(); // not started — should not throw
      monitor.start();
      monitor.stop();
      monitor.stop(); // already stopped — should not throw
    });
  });

  describe('state change events via checkTimeouts', () => {
    it('publishes health.state_changed when state degrades', () => {
      monitor.recordHeartbeat('tid-test-001', []);
      monitor.start();

      vi.advanceTimersByTime(30_000); // triggers checkTimeouts

      const changed = bus.events.find(e => e.type === 'health.state_changed');
      expect(changed).toBeDefined();
      expect(changed!.data.tid).toBe('tid-test-001');
      expect(changed!.data.previousState).toBe(ContainerHealth.Running);
      expect(changed!.data.newState).toBe(ContainerHealth.Degraded);
    });

    it('publishes events for each state transition', () => {
      monitor.recordHeartbeat('tid-test-001', []);
      monitor.start();

      vi.advanceTimersByTime(30_000); // running -> degraded
      vi.advanceTimersByTime(30_000); // degraded -> unhealthy
      vi.advanceTimersByTime(30_000); // unhealthy -> unreachable

      const changes = bus.events.filter(e => e.type === 'health.state_changed');
      expect(changes).toHaveLength(3);
      expect(changes[0].data.newState).toBe(ContainerHealth.Degraded);
      expect(changes[1].data.newState).toBe(ContainerHealth.Unhealthy);
      expect(changes[2].data.newState).toBe(ContainerHealth.Unreachable);
    });
  });

  describe('multiple containers tracked independently', () => {
    it('tracks containers with different heartbeat times', () => {
      monitor.recordHeartbeat('tid-test-001', []);
      vi.advanceTimersByTime(20_000);
      monitor.recordHeartbeat('tid-test-002', []);
      vi.advanceTimersByTime(15_000);

      // tid-test-001: 35s elapsed -> degraded
      // tid-test-002: 15s elapsed -> running
      expect(monitor.getHealth('tid-test-001')).toBe(ContainerHealth.Degraded);
      expect(monitor.getHealth('tid-test-002')).toBe(ContainerHealth.Running);
    });
  });
});
