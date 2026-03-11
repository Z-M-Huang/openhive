import type { BusEvent, EventBus, EventFilter, EventHandler } from '../domain/index.js';

/**
 * In-memory pub/sub event bus for internal system events.
 *
 * **Event types:**
 * - `heartbeat` — periodic container health heartbeat
 * - `task.state_changed` — task status transitions (pending → assigned → running → completed/failed)
 * - `container.started` / `container.stopped` / `container.health_changed` — container lifecycle
 * - `trigger.fired` — trigger activation (future feature)
 * - `org_chart.updated` — agent or team added/removed/modified
 *
 * **Ordering guarantees:**
 * - Per-subscriber ordering is preserved: events are delivered to each subscriber
 *   in the order they were published.
 * - No global ordering guarantee across subscribers.
 *
 * **Lifecycle:**
 * - After {@link close} is called, no new subscriptions are accepted and no further
 *   events are published. Pending deliveries are drained before shutdown completes.
 */
export class EventBusImpl implements EventBus {
  /**
   * Publish an event to all matching subscribers.
   * Filtered subscribers only receive the event if their filter returns true.
   * Delivery order per-subscriber matches publish order.
   */
  publish(_event: BusEvent): void {
    throw new Error('Not implemented');
  }

  /**
   * Subscribe to all events. Returns a unique subscription ID.
   * The handler is called synchronously for each published event.
   */
  subscribe(_handler: EventHandler): string {
    throw new Error('Not implemented');
  }

  /**
   * Subscribe to events matching a filter predicate. Returns a unique subscription ID.
   * The handler is only called when the filter returns true for the event.
   */
  filteredSubscribe(_filter: EventFilter, _handler: EventHandler): string {
    throw new Error('Not implemented');
  }

  /**
   * Remove a subscription by its ID. No-op if the subscription does not exist.
   */
  unsubscribe(_subscriptionId: string): void {
    throw new Error('Not implemented');
  }

  /**
   * Close the event bus. After close:
   * - New subscriptions are rejected.
   * - New publishes are silently dropped.
   * - Pending deliveries are drained.
   */
  close(): void {
    throw new Error('Not implemented');
  }
}
