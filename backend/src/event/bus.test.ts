/**
 * Tests for backend/src/event/bus.ts
 *
 * Covers:
 *   - Publish delivers events to subscribers
 *   - Subscribe returns unique subscription ID
 *   - Unsubscribe removes handler
 *   - FilteredSubscribe only delivers matching events
 *   - Close prevents new publishes
 *   - Multiple subscribers for same event type all receive
 *   - Handler timeout warning is logged after 5 seconds
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryBus, newEventBus, newEventBusWithWarn } from './bus.js';
import type { Event } from '../domain/types.js';
import type { EventType } from '../domain/enums.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a minimal valid Event for testing. */
function makeEvent(type: EventType = 'task_created'): Event {
  return {
    type,
    payload: {
      kind: 'task_created',
      task: {
        id: 'task-1',
        team_slug: 'test-team',
        status: 'pending',
        prompt: 'do something',
        created_at: new Date(),
        updated_at: new Date(),
        completed_at: null,
      },
    },
  };
}

/** Builds a task_completed event. */
function makeCompletedEvent(): Event {
  return {
    type: 'task_completed',
    payload: {
      kind: 'task_completed',
      task_id: 'task-1',
      result: {
        task_id: 'task-1',
        status: 'completed',
        result: 'done',
        duration: 100,
      },
    },
  };
}

/** Waits for all queued setImmediate callbacks to execute. */
async function flushImmediate(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Constructor / factory
// ---------------------------------------------------------------------------

describe('InMemoryBus constructor and factories', () => {
  it('newEventBus returns an InMemoryBus instance', () => {
    const bus = newEventBus();
    expect(bus).toBeInstanceOf(InMemoryBus);
    bus.close();
  });

  it('newEventBusWithWarn returns an InMemoryBus with custom warn function', () => {
    const warns: string[] = [];
    const bus = newEventBusWithWarn((msg) => warns.push(msg));
    expect(bus).toBeInstanceOf(InMemoryBus);
    bus.close();
  });

  it('starts not closed', () => {
    const bus = newEventBus();
    expect(bus.isClosed()).toBe(false);
    bus.close();
  });

  it('starts with zero subscriptions', () => {
    const bus = newEventBus();
    expect(bus.subscriptionCount()).toBe(0);
    bus.close();
  });
});

// ---------------------------------------------------------------------------
// subscribe
// ---------------------------------------------------------------------------

describe('subscribe', () => {
  it('returns a non-empty string subscription ID', () => {
    const bus = newEventBus();
    const id = bus.subscribe('task_created', () => {});
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    bus.close();
  });

  it('returns unique IDs for each subscription', () => {
    const bus = newEventBus();
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      ids.add(bus.subscribe('task_created', () => {}));
    }
    expect(ids.size).toBe(20);
    bus.close();
  });

  it('increments subscription count', () => {
    const bus = newEventBus();
    bus.subscribe('task_created', () => {});
    bus.subscribe('task_updated', () => {});
    expect(bus.subscriptionCount()).toBe(2);
    bus.close();
  });

  it('allows multiple subscriptions for the same event type', () => {
    const bus = newEventBus();
    const id1 = bus.subscribe('task_created', () => {});
    const id2 = bus.subscribe('task_created', () => {});
    expect(id1).not.toBe(id2);
    expect(bus.subscriptionCount()).toBe(2);
    bus.close();
  });

  it('IDs are valid UUIDs (v4 format)', () => {
    const bus = newEventBus();
    const id = bus.subscribe('task_created', () => {});
    // UUID v4: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    bus.close();
  });
});

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

describe('publish', () => {
  it('delivers an event to a subscriber', async () => {
    const bus = newEventBus();
    const received: Event[] = [];
    bus.subscribe('task_created', (e) => received.push(e));

    const event = makeEvent('task_created');
    bus.publish(event);
    await flushImmediate();

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(event);
    bus.close();
  });

  it('does not deliver an event to a subscriber for a different event type', async () => {
    const bus = newEventBus();
    const received: Event[] = [];
    bus.subscribe('task_updated', (e) => received.push(e));

    bus.publish(makeEvent('task_created'));
    await flushImmediate();

    expect(received).toHaveLength(0);
    bus.close();
  });

  it('delivers to all subscribers for the same event type', async () => {
    const bus = newEventBus();
    const counts = [0, 0, 0];
    bus.subscribe('task_created', () => { counts[0]++; });
    bus.subscribe('task_created', () => { counts[1]++; });
    bus.subscribe('task_created', () => { counts[2]++; });

    bus.publish(makeEvent('task_created'));
    await flushImmediate();

    expect(counts).toEqual([1, 1, 1]);
    bus.close();
  });

  it('delivers to subscribers on different event types independently', async () => {
    const bus = newEventBus();
    const createdReceived: Event[] = [];
    const completedReceived: Event[] = [];

    bus.subscribe('task_created', (e) => createdReceived.push(e));
    bus.subscribe('task_completed', (e) => completedReceived.push(e));

    const created = makeEvent('task_created');
    const completed = makeCompletedEvent();

    bus.publish(created);
    bus.publish(completed);
    await flushImmediate();

    expect(createdReceived).toHaveLength(1);
    expect(createdReceived[0]).toBe(created);
    expect(completedReceived).toHaveLength(1);
    expect(completedReceived[0]).toBe(completed);
    bus.close();
  });

  it('is a no-op when there are no subscribers for the event type', async () => {
    // Should not throw
    const bus = newEventBus();
    expect(() => bus.publish(makeEvent('task_created'))).not.toThrow();
    await flushImmediate();
    bus.close();
  });

  it('dispatches asynchronously (handler not called synchronously)', () => {
    const bus = newEventBus();
    let called = false;
    bus.subscribe('task_created', () => { called = true; });

    bus.publish(makeEvent('task_created'));
    // Handler should NOT have been called yet (setImmediate defers it)
    expect(called).toBe(false);
    bus.close();
  });

  it('delivers event payload correctly', async () => {
    const bus = newEventBus();
    const received: Event[] = [];
    bus.subscribe('task_created', (e) => received.push(e));

    const event = makeEvent('task_created');
    bus.publish(event);
    await flushImmediate();

    expect(received[0]?.payload).toEqual(event.payload);
    bus.close();
  });

  it('is a no-op after close()', async () => {
    const bus = newEventBus();
    const received: Event[] = [];
    bus.subscribe('task_created', (e) => received.push(e));

    bus.close();
    bus.publish(makeEvent('task_created'));
    await flushImmediate();

    expect(received).toHaveLength(0);
  });

  it('handles async handlers correctly', async () => {
    const bus = newEventBus();
    const received: Event[] = [];

    bus.subscribe('task_created', async (e) => {
      await Promise.resolve(); // simulate async work
      received.push(e);
    });

    bus.publish(makeEvent('task_created'));
    await flushImmediate();
    // Need an extra tick for the async handler to complete
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(received).toHaveLength(1);
    bus.close();
  });

  it('continues delivering to other handlers if one handler throws synchronously', async () => {
    const warns: string[] = [];
    const bus = newEventBusWithWarn((msg) => warns.push(msg));
    const received: Event[] = [];

    bus.subscribe('task_created', () => { throw new Error('boom'); });
    bus.subscribe('task_created', (e) => received.push(e));

    bus.publish(makeEvent('task_created'));
    await flushImmediate();

    expect(received).toHaveLength(1);
    expect(warns.some((w) => w.includes('boom'))).toBe(true);
    bus.close();
  });

  it('logs warning when async handler rejects', async () => {
    const warns: string[] = [];
    const bus = newEventBusWithWarn((msg) => warns.push(msg));

    bus.subscribe('task_created', async () => {
      throw new Error('async-boom');
    });

    bus.publish(makeEvent('task_created'));
    await flushImmediate();
    // Allow the rejected promise to be handled
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(warns.some((w) => w.includes('async-boom'))).toBe(true);
    bus.close();
  });
});

// ---------------------------------------------------------------------------
// unsubscribe
// ---------------------------------------------------------------------------

describe('unsubscribe', () => {
  it('removes the handler so subsequent publishes skip it', async () => {
    const bus = newEventBus();
    const received: Event[] = [];
    const id = bus.subscribe('task_created', (e) => received.push(e));

    bus.unsubscribe(id);
    bus.publish(makeEvent('task_created'));
    await flushImmediate();

    expect(received).toHaveLength(0);
    bus.close();
  });

  it('decrements subscription count', () => {
    const bus = newEventBus();
    const id1 = bus.subscribe('task_created', () => {});
    bus.subscribe('task_created', () => {});
    expect(bus.subscriptionCount()).toBe(2);

    bus.unsubscribe(id1);
    expect(bus.subscriptionCount()).toBe(1);
    bus.close();
  });

  it('is a no-op for an unknown subscription ID', () => {
    const bus = newEventBus();
    expect(() => bus.unsubscribe('non-existent-id')).not.toThrow();
    bus.close();
  });

  it('is idempotent — calling twice does not panic', () => {
    const bus = newEventBus();
    const id = bus.subscribe('task_created', () => {});
    bus.unsubscribe(id);
    expect(() => bus.unsubscribe(id)).not.toThrow();
    bus.close();
  });

  it('only removes the specified subscription, leaving others intact', async () => {
    const bus = newEventBus();
    const received1: Event[] = [];
    const received2: Event[] = [];

    const id1 = bus.subscribe('task_created', (e) => received1.push(e));
    bus.subscribe('task_created', (e) => received2.push(e));

    bus.unsubscribe(id1);
    bus.publish(makeEvent('task_created'));
    await flushImmediate();

    expect(received1).toHaveLength(0);
    expect(received2).toHaveLength(1);
    bus.close();
  });

  it('cleans up empty handler maps after last unsubscribe', () => {
    const bus = newEventBus();
    const id = bus.subscribe('task_created', () => {});
    bus.unsubscribe(id);
    expect(bus.subscriptionCount()).toBe(0);
    bus.close();
  });
});

// ---------------------------------------------------------------------------
// filteredSubscribe
// ---------------------------------------------------------------------------

describe('filteredSubscribe', () => {
  it('returns a subscription ID like subscribe()', () => {
    const bus = newEventBus();
    const id = bus.filteredSubscribe('task_created', () => true, () => {});
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    bus.close();
  });

  it('delivers event when filter returns true', async () => {
    const bus = newEventBus();
    const received: Event[] = [];

    bus.filteredSubscribe('task_created', () => true, (e) => received.push(e));
    bus.publish(makeEvent('task_created'));
    await flushImmediate();

    expect(received).toHaveLength(1);
    bus.close();
  });

  it('does NOT deliver event when filter returns false', async () => {
    const bus = newEventBus();
    const received: Event[] = [];

    bus.filteredSubscribe('task_created', () => false, (e) => received.push(e));
    bus.publish(makeEvent('task_created'));
    await flushImmediate();

    expect(received).toHaveLength(0);
    bus.close();
  });

  it('passes the event to the filter function', async () => {
    const bus = newEventBus();
    const filterArg: Event[] = [];

    bus.filteredSubscribe(
      'task_created',
      (e) => { filterArg.push(e); return false; },
      () => {},
    );
    const event = makeEvent('task_created');
    bus.publish(event);
    await flushImmediate();

    expect(filterArg).toHaveLength(1);
    expect(filterArg[0]).toBe(event);
    bus.close();
  });

  it('can be used to match events based on payload content', async () => {
    const bus = newEventBus();
    const received: Event[] = [];

    // Only receive events whose payload kind is 'task_created'
    bus.filteredSubscribe(
      'task_created',
      (e) => e.payload.kind === 'task_created',
      (e) => received.push(e),
    );

    bus.publish(makeEvent('task_created'));
    await flushImmediate();

    expect(received).toHaveLength(1);
    bus.close();
  });

  it('can be unsubscribed with the returned ID', async () => {
    const bus = newEventBus();
    const received: Event[] = [];

    const id = bus.filteredSubscribe('task_created', () => true, (e) => received.push(e));
    bus.unsubscribe(id);
    bus.publish(makeEvent('task_created'));
    await flushImmediate();

    expect(received).toHaveLength(0);
    bus.close();
  });

  it('mixing filtered and unfiltered subscribers for same event type', async () => {
    const bus = newEventBus();
    const unfilteredReceived: Event[] = [];
    const filteredReceived: Event[] = [];

    bus.subscribe('task_created', (e) => unfilteredReceived.push(e));
    bus.filteredSubscribe('task_created', () => false, (e) => filteredReceived.push(e));

    bus.publish(makeEvent('task_created'));
    await flushImmediate();

    expect(unfilteredReceived).toHaveLength(1);
    expect(filteredReceived).toHaveLength(0);
    bus.close();
  });
});

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

describe('close', () => {
  it('marks the bus as closed', () => {
    const bus = newEventBus();
    expect(bus.isClosed()).toBe(false);
    bus.close();
    expect(bus.isClosed()).toBe(true);
  });

  it('prevents new publishes from dispatching', async () => {
    const bus = newEventBus();
    const received: Event[] = [];
    bus.subscribe('task_created', (e) => received.push(e));

    bus.close();
    bus.publish(makeEvent('task_created'));
    await flushImmediate();

    expect(received).toHaveLength(0);
  });

  it('is idempotent — calling close twice does not throw', () => {
    const bus = newEventBus();
    bus.close();
    expect(() => bus.close()).not.toThrow();
  });

  it('allows subscribe() after close (subscriptions still registered)', () => {
    // The bus close() only blocks publish — new subscriptions are still accepted
    // but no events will flow.
    const bus = newEventBus();
    bus.close();
    expect(() => bus.subscribe('task_created', () => {})).not.toThrow();
    expect(bus.subscriptionCount()).toBe(1);
  });

  it('allows unsubscribe() after close', () => {
    const bus = newEventBus();
    const id = bus.subscribe('task_created', () => {});
    bus.close();
    expect(() => bus.unsubscribe(id)).not.toThrow();
    expect(bus.subscriptionCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Handler timeout warning
// ---------------------------------------------------------------------------

describe('handler timeout warning', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('logs a warning when a slow async handler exceeds 5 seconds', async () => {
    const warns: string[] = [];
    const bus = newEventBusWithWarn((msg) => warns.push(msg));

    // Subscribe a handler that never resolves within the timeout window.
    bus.subscribe('task_created', () => {
      return new Promise<void>(() => {
        // Intentionally never resolves within the timeout.
      });
    });

    bus.publish(makeEvent('task_created'));

    // vi.runAllTimersAsync() runs all pending fake timers including setImmediate,
    // which kicks off the handler dispatch, then advances past the 5s threshold.
    vi.advanceTimersByTime(5_001);
    await vi.runAllTimersAsync();

    expect(warns.some((w) => w.includes('task_created') && w.includes('5000ms'))).toBe(true);
    bus.close();
  });

  it('does NOT log a warning when a handler completes before 5 seconds', async () => {
    const warns: string[] = [];
    const bus = newEventBusWithWarn((msg) => warns.push(msg));

    bus.subscribe('task_created', async () => {
      await Promise.resolve(); // Resolves immediately
    });

    bus.publish(makeEvent('task_created'));
    // Run the setImmediate (which dispatches the handler) and let the async
    // handler complete before advancing timers.
    await vi.runAllTimersAsync();
    // Yield to allow promise chains to settle.
    await Promise.resolve();
    await Promise.resolve();

    // Now advance past the 5s threshold — timeout should have been cleared.
    vi.advanceTimersByTime(5_001);

    expect(warns.filter((w) => w.includes('exceeded'))).toHaveLength(0);
    bus.close();
  });

  it('warning message includes the event type', async () => {
    const warns: string[] = [];
    const bus = newEventBusWithWarn((msg) => warns.push(msg));

    bus.subscribe('team_created', () => {
      return new Promise<void>(() => {}); // never resolves
    });

    bus.publish({
      type: 'team_created',
      payload: { kind: 'team_created', team_id: 'tid-test' },
    });

    vi.advanceTimersByTime(5_001);
    await vi.runAllTimersAsync();

    expect(warns.some((w) => w.includes('team_created'))).toBe(true);
    bus.close();
  });
});

// ---------------------------------------------------------------------------
// Integration: multiple event types and mixed operations
// ---------------------------------------------------------------------------

describe('integration', () => {
  it('handles publish → unsubscribe → re-subscribe cycle', async () => {
    const bus = newEventBus();
    const received: Event[] = [];

    const id = bus.subscribe('task_created', (e) => received.push(e));
    bus.publish(makeEvent('task_created'));
    await flushImmediate();
    expect(received).toHaveLength(1);

    bus.unsubscribe(id);
    bus.publish(makeEvent('task_created'));
    await flushImmediate();
    expect(received).toHaveLength(1); // Not incremented

    bus.subscribe('task_created', (e) => received.push(e));
    bus.publish(makeEvent('task_created'));
    await flushImmediate();
    expect(received).toHaveLength(2);

    bus.close();
  });

  it('handles many concurrent publishes across different event types', async () => {
    const bus = newEventBus();
    const counts: Record<string, number> = { task_created: 0, task_completed: 0 };

    bus.subscribe('task_created', () => { counts['task_created']++; });
    bus.subscribe('task_completed', () => { counts['task_completed']++; });

    const N = 10;
    for (let i = 0; i < N; i++) {
      bus.publish(makeEvent('task_created'));
      bus.publish(makeCompletedEvent());
    }

    // Flush all queued setImmediate callbacks
    for (let i = 0; i < N * 2 + 1; i++) {
      await flushImmediate();
    }

    expect(counts['task_created']).toBe(N);
    expect(counts['task_completed']).toBe(N);
    bus.close();
  });

  it('subscriptions are independent across event types', async () => {
    const bus = newEventBus();
    const createdCount = { val: 0 };
    const completedCount = { val: 0 };

    bus.subscribe('task_created', () => { createdCount.val++; });
    bus.subscribe('task_completed', () => { completedCount.val++; });

    // Publish only to task_created
    bus.publish(makeEvent('task_created'));
    await flushImmediate();

    expect(createdCount.val).toBe(1);
    expect(completedCount.val).toBe(0);
    bus.close();
  });

  it('newEventBusWithWarn uses provided warn function, not console.warn', async () => {
    const consoleSpy = vi.spyOn(console, 'warn');
    const customWarns: string[] = [];
    const bus = newEventBusWithWarn((msg) => customWarns.push(msg));

    bus.subscribe('task_created', () => { throw new Error('test'); });
    bus.publish(makeEvent('task_created'));
    await flushImmediate();

    expect(customWarns.some((w) => w.includes('test'))).toBe(true);
    expect(consoleSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
    bus.close();
  });
});
