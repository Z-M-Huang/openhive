import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DispatchTrackerImpl } from './dispatch-tracker.js';
import type { EventBus, BusEvent } from '../domain/index.js';

// ---------------------------------------------------------------------------
// Minimal EventBus test double
// ---------------------------------------------------------------------------

function makeEventBus(): EventBus & { published: BusEvent[] } {
  const published: BusEvent[] = [];
  return {
    published,
    publish(event: BusEvent) {
      published.push(event);
    },
    subscribe: vi.fn().mockReturnValue('sub-1'),
    filteredSubscribe: vi.fn().mockReturnValue('sub-2'),
    unsubscribe: vi.fn(),
    close: vi.fn(),
  };
}

describe('DispatchTrackerImpl', () => {
  let eventBus: ReturnType<typeof makeEventBus>;
  let tracker: DispatchTrackerImpl;

  beforeEach(() => {
    vi.useFakeTimers();
    eventBus = makeEventBus();
    tracker = new DispatchTrackerImpl(eventBus);
  });

  afterEach(() => {
    tracker.stop();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // start / stop lifecycle
  // -------------------------------------------------------------------------

  describe('lifecycle', () => {
    it('start() marks tracker as started', () => {
      expect(tracker.isStarted()).toBe(false);
      tracker.start();
      expect(tracker.isStarted()).toBe(true);
    });

    it('stop() marks tracker as not started', () => {
      tracker.start();
      tracker.stop();
      expect(tracker.isStarted()).toBe(false);
    });

    it('calling start() twice is a no-op (idempotent)', () => {
      tracker.start();
      tracker.start();
      expect(tracker.isStarted()).toBe(true);
    });

    it('stop() clears all pending timers so no events fire after stop', () => {
      tracker.start();
      tracker.trackDispatch('task-1', 'tid-alpha-1234', 'aid-agent-0001');
      tracker.trackDispatch('task-2', 'tid-alpha-1234', 'aid-agent-0001');

      tracker.stop();

      // Advance past grace period — no events should be emitted
      vi.advanceTimersByTime(61_000);

      expect(eventBus.published).toHaveLength(0);
    });

    it('stop() empties the entry map', () => {
      tracker.start();
      tracker.trackDispatch('task-1', 'tid-alpha-1234', 'aid-agent-0001');
      tracker.stop();

      expect(tracker.getUnacknowledged('tid-alpha-1234')).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // trackDispatch
  // -------------------------------------------------------------------------

  describe('trackDispatch()', () => {
    it('adds a task entry visible via getUnacknowledged', () => {
      tracker.start();
      tracker.trackDispatch('task-1', 'tid-alpha-1234', 'aid-agent-0001');

      expect(tracker.getUnacknowledged('tid-alpha-1234')).toContain('task-1');
    });

    it('calling trackDispatch twice for the same taskId is a no-op', () => {
      tracker.start();
      tracker.trackDispatch('task-1', 'tid-alpha-1234', 'aid-agent-0001');
      tracker.trackDispatch('task-1', 'tid-alpha-1234', 'aid-agent-0001');

      expect(tracker.getUnacknowledged('tid-alpha-1234')).toHaveLength(1);
    });

    it('different tasks are tracked independently', () => {
      tracker.start();
      tracker.trackDispatch('task-1', 'tid-alpha-1234', 'aid-agent-0001');
      tracker.trackDispatch('task-2', 'tid-alpha-1234', 'aid-agent-0001');

      const result = tracker.getUnacknowledged('tid-alpha-1234');
      expect(result).toContain('task-1');
      expect(result).toContain('task-2');
      expect(result).toHaveLength(2);
    });

    it('tasks dispatched to different TIDs are stored separately', () => {
      tracker.start();
      tracker.trackDispatch('task-1', 'tid-alpha-1234', 'aid-agent-0001');
      tracker.trackDispatch('task-2', 'tid-beta-abcd', 'aid-agent-0002');

      expect(tracker.getUnacknowledged('tid-alpha-1234')).toEqual(['task-1']);
      expect(tracker.getUnacknowledged('tid-beta-abcd')).toEqual(['task-2']);
    });
  });

  // -------------------------------------------------------------------------
  // acknowledgeDispatch
  // -------------------------------------------------------------------------

  describe('acknowledgeDispatch()', () => {
    it('removes task from unacknowledged list', () => {
      tracker.start();
      tracker.trackDispatch('task-1', 'tid-alpha-1234', 'aid-agent-0001');
      tracker.acknowledgeDispatch('task-1');

      expect(tracker.getUnacknowledged('tid-alpha-1234')).toHaveLength(0);
    });

    it('cancels the timeout so no event fires after acknowledgement', () => {
      tracker.start();
      tracker.trackDispatch('task-1', 'tid-alpha-1234', 'aid-agent-0001');
      tracker.acknowledgeDispatch('task-1');

      vi.advanceTimersByTime(61_000);

      expect(eventBus.published).toHaveLength(0);
    });

    it('acknowledging a task does not affect other tracked tasks', () => {
      tracker.start();
      tracker.trackDispatch('task-1', 'tid-alpha-1234', 'aid-agent-0001');
      tracker.trackDispatch('task-2', 'tid-alpha-1234', 'aid-agent-0001');
      tracker.acknowledgeDispatch('task-1');

      expect(tracker.getUnacknowledged('tid-alpha-1234')).toEqual(['task-2']);
    });

    it('acknowledging a non-tracked task is a no-op', () => {
      tracker.start();
      expect(() => tracker.acknowledgeDispatch('nonexistent-task')).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // getUnacknowledged
  // -------------------------------------------------------------------------

  describe('getUnacknowledged()', () => {
    it('returns empty array when no tasks are tracked for the TID', () => {
      tracker.start();
      expect(tracker.getUnacknowledged('tid-unknown-0000')).toEqual([]);
    });

    it('filters by TID correctly', () => {
      tracker.start();
      tracker.trackDispatch('task-a', 'tid-alpha-1234', 'aid-agent-0001');
      tracker.trackDispatch('task-b', 'tid-beta-abcd', 'aid-agent-0002');
      tracker.trackDispatch('task-c', 'tid-alpha-1234', 'aid-agent-0003');

      const alphaResults = tracker.getUnacknowledged('tid-alpha-1234');
      expect(alphaResults).toHaveLength(2);
      expect(alphaResults).toContain('task-a');
      expect(alphaResults).toContain('task-c');
      expect(alphaResults).not.toContain('task-b');
    });
  });

  // -------------------------------------------------------------------------
  // dispatch.timeout event
  // -------------------------------------------------------------------------

  describe('dispatch.timeout event', () => {
    it('emits dispatch.timeout event after 60s grace period', () => {
      tracker.start();
      tracker.trackDispatch('task-1', 'tid-alpha-1234', 'aid-agent-0001');

      // Just before timeout — no event yet
      vi.advanceTimersByTime(59_999);
      expect(eventBus.published).toHaveLength(0);

      // At the 60s mark — event fires
      vi.advanceTimersByTime(1);
      expect(eventBus.published).toHaveLength(1);
      expect(eventBus.published[0]!.type).toBe('dispatch.timeout');
    });

    it('timeout event includes taskId, tid, and agentAid in data', () => {
      tracker.start();
      tracker.trackDispatch('task-42', 'tid-gamma-5678', 'aid-agent-0003');

      vi.advanceTimersByTime(60_000);

      expect(eventBus.published).toHaveLength(1);
      const event = eventBus.published[0]!;
      expect(event.data).toMatchObject({
        taskId: 'task-42',
        tid: 'tid-gamma-5678',
        agentAid: 'aid-agent-0003',
      });
    });

    it('timeout event has source set to DispatchTracker', () => {
      tracker.start();
      tracker.trackDispatch('task-1', 'tid-alpha-1234', 'aid-agent-0001');

      vi.advanceTimersByTime(60_000);

      expect(eventBus.published[0]!.source).toBe('DispatchTracker');
    });

    it('timed-out task is removed from unacknowledged list', () => {
      tracker.start();
      tracker.trackDispatch('task-1', 'tid-alpha-1234', 'aid-agent-0001');

      vi.advanceTimersByTime(60_000);

      expect(tracker.getUnacknowledged('tid-alpha-1234')).toHaveLength(0);
    });

    it('each timed-out task emits its own event', () => {
      tracker.start();
      tracker.trackDispatch('task-1', 'tid-alpha-1234', 'aid-agent-0001');
      tracker.trackDispatch('task-2', 'tid-alpha-1234', 'aid-agent-0001');

      vi.advanceTimersByTime(60_000);

      expect(eventBus.published).toHaveLength(2);
      const taskIds = eventBus.published.map((e) => e.data['taskId']);
      expect(taskIds).toContain('task-1');
      expect(taskIds).toContain('task-2');
    });

    it('does not emit event if task is acknowledged before timeout', () => {
      tracker.start();
      tracker.trackDispatch('task-1', 'tid-alpha-1234', 'aid-agent-0001');

      // Acknowledge well before grace period
      vi.advanceTimersByTime(30_000);
      tracker.acknowledgeDispatch('task-1');

      // Advance past original timeout
      vi.advanceTimersByTime(30_001);

      expect(eventBus.published).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Interface compliance
  // -------------------------------------------------------------------------

  describe('interface compliance', () => {
    it('implements the DispatchTracker interface', () => {
      // Structural check: all interface methods exist
      expect(typeof tracker.trackDispatch).toBe('function');
      expect(typeof tracker.acknowledgeDispatch).toBe('function');
      expect(typeof tracker.getUnacknowledged).toBe('function');
      expect(typeof tracker.start).toBe('function');
      expect(typeof tracker.stop).toBe('function');
    });
  });
});
