import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventBusImpl } from './event-bus.js';
import type { BusEvent } from '../domain/index.js';

function makeEvent(type = 'test.event', data: Record<string, unknown> = {}): BusEvent {
  return { type, data, timestamp: Date.now() };
}

/** Flush pending microtasks so queueMicrotask callbacks execute. */
async function flushMicrotasks(): Promise<void> {
  // Each await drains the microtask queue once; two passes cover handlers
  // that themselves schedule microtasks.
  await Promise.resolve();
  await Promise.resolve();
}

describe('EventBusImpl', () => {
  let bus: EventBusImpl;

  afterEach(() => {
    bus?.close();
  });

  // -----------------------------------------------------------------------
  // Basic publish / subscribe
  // -----------------------------------------------------------------------

  it('delivers published event to subscriber', async () => {
    bus = new EventBusImpl();
    const received: BusEvent[] = [];
    bus.subscribe((e) => received.push(e));

    const event = makeEvent();
    bus.publish(event);
    await flushMicrotasks();

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(event);
  });

  it('delivers to multiple subscribers', async () => {
    bus = new EventBusImpl();
    const a: BusEvent[] = [];
    const b: BusEvent[] = [];
    bus.subscribe((e) => a.push(e));
    bus.subscribe((e) => b.push(e));

    const event = makeEvent();
    bus.publish(event);
    await flushMicrotasks();

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]).toBe(event);
    expect(b[0]).toBe(event);
  });

  // -----------------------------------------------------------------------
  // Filtered subscribe
  // -----------------------------------------------------------------------

  it('filtered subscriber receives only matching events', async () => {
    bus = new EventBusImpl();
    const received: BusEvent[] = [];
    bus.filteredSubscribe(
      (e) => e.type === 'task.state_changed',
      (e) => received.push(e),
    );

    bus.publish(makeEvent('heartbeat'));
    bus.publish(makeEvent('task.state_changed'));
    bus.publish(makeEvent('container.started'));
    await flushMicrotasks();

    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe('task.state_changed');
  });

  it('filter returning false prevents handler call', async () => {
    bus = new EventBusImpl();
    const handler = vi.fn();
    bus.filteredSubscribe(() => false, handler);

    bus.publish(makeEvent());
    await flushMicrotasks();

    expect(handler).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Unsubscribe
  // -----------------------------------------------------------------------

  it('unsubscribe stops delivery', async () => {
    bus = new EventBusImpl();
    const received: BusEvent[] = [];
    const id = bus.subscribe((e) => received.push(e));

    bus.publish(makeEvent());
    await flushMicrotasks();
    expect(received).toHaveLength(1);

    bus.unsubscribe(id);
    bus.publish(makeEvent());
    await flushMicrotasks();
    expect(received).toHaveLength(1); // no new delivery
  });

  it('unsubscribe with unknown id is a no-op', () => {
    bus = new EventBusImpl();
    expect(() => bus.unsubscribe('nonexistent-id')).not.toThrow();
  });

  // -----------------------------------------------------------------------
  // Async isolation
  // -----------------------------------------------------------------------

  it('handlers run asynchronously and independently', async () => {
    bus = new EventBusImpl();
    const order: string[] = [];

    // "slow" handler — schedules work further in microtask queue
    bus.subscribe(() => {
      queueMicrotask(() => order.push('slow'));
    });

    // "fast" handler
    bus.subscribe(() => {
      order.push('fast');
    });

    bus.publish(makeEvent());
    await flushMicrotasks();

    // fast handler should have run; slow handler's nested microtask also resolves
    expect(order).toContain('fast');
    expect(order).toContain('slow');
  });

  // -----------------------------------------------------------------------
  // Error isolation
  // -----------------------------------------------------------------------

  it('throwing handler does not affect other handlers', async () => {
    bus = new EventBusImpl();
    const received: BusEvent[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe((e) => received.push(e));

    bus.publish(makeEvent());
    await flushMicrotasks();

    expect(received).toHaveLength(1);
    expect(consoleError).toHaveBeenCalledWith(
      'EventBus handler error:',
      expect.any(Error),
    );

    consoleError.mockRestore();
  });

  // -----------------------------------------------------------------------
  // close() semantics
  // -----------------------------------------------------------------------

  it('publish after close is a no-op', async () => {
    bus = new EventBusImpl();
    const received: BusEvent[] = [];
    bus.subscribe((e) => received.push(e));

    bus.close();
    bus.publish(makeEvent());
    await flushMicrotasks();

    expect(received).toHaveLength(0);
  });

  it('subscribe after close returns empty string and is a no-op', async () => {
    bus = new EventBusImpl();
    bus.close();

    const id = bus.subscribe(vi.fn());
    expect(id).toBe('');
  });

  it('filteredSubscribe after close returns empty string', () => {
    bus = new EventBusImpl();
    bus.close();

    const id = bus.filteredSubscribe(() => true, vi.fn());
    expect(id).toBe('');
  });

  // -----------------------------------------------------------------------
  // Subscription ID uniqueness
  // -----------------------------------------------------------------------

  it('returns unique subscription IDs', () => {
    bus = new EventBusImpl();
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(bus.subscribe(vi.fn()));
    }
    expect(ids.size).toBe(100);
  });
});
