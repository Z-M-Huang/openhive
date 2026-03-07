/**
 * OpenHive Backend - In-Memory Event Bus
 *
 * Design notes:
 *   - No worker pool — Node.js is single-threaded. Handlers are dispatched
 *     asynchronously via setImmediate (next I/O tick), which gives equivalent
 *     non-blocking semantics.
 *   - Timeout detection uses a 5s wall-clock timer per handler invocation that
 *     logs a warning if the handler (an async function or a slow sync function)
 *     has not resolved by the deadline.
 *   - Subscription IDs are generated with crypto.randomUUID() (Node.js built-in).
 *   - A reverse map (subscriptionID → EventType) enables O(1) unsubscribe.
 */

import { randomUUID } from 'node:crypto';
import type { EventBus } from '../domain/interfaces.js';
import type { Event } from '../domain/types.js';
import type { EventType } from '../domain/enums.js';

/** Duration in milliseconds after which a handler invocation logs a warning. */
const HANDLER_TIMEOUT_MS = 5_000;

/**
 * InMemoryBus is a publish/subscribe event bus with typed events and async
 * dispatch. It implements the EventBus domain interface.
 *
 * Subscribers register handlers keyed by a UUID subscription ID. Handlers are
 * invoked asynchronously (via setImmediate) so that publish() is fire-and-forget
 * from the caller's perspective. A per-invocation timeout timer logs a warning
 * if a handler takes longer than 5 seconds to complete.
 */
export class InMemoryBus implements EventBus {
  /** Primary subscription map: EventType → (subscriptionID → handler). */
  private readonly subs: Map<EventType, Map<string, (event: Event) => void | Promise<void>>>;

  /** Reverse map: subscriptionID → EventType. Enables O(1) lookup in unsubscribe(). */
  private readonly reverseMap: Map<string, EventType>;

  /** When true, publish() is rejected and no new events are dispatched. */
  private closed: boolean;

  /** Optional logger for warning output. Defaults to console.warn if not provided. */
  private readonly warnFn: (message: string) => void;

  constructor(warnFn?: (message: string) => void) {
    this.subs = new Map();
    this.reverseMap = new Map();
    this.closed = false;
    this.warnFn = warnFn ?? ((msg) => console.warn(msg));
  }

  /**
   * Publish sends an event to all subscribers registered for the event's type.
   * Each handler is invoked asynchronously via setImmediate so the caller
   * returns immediately (fire-and-forget). A 5-second timeout timer per handler
   * logs a warning if the handler has not resolved.
   *
   * If the bus is closed, publish() is a no-op.
   */
  publish(event: Event): void {
    if (this.closed) {
      return;
    }

    const handlerMap = this.subs.get(event.type);
    if (handlerMap === undefined || handlerMap.size === 0) {
      return;
    }

    // Snapshot handlers at publish time to avoid mutation issues during dispatch.
    const handlers = Array.from(handlerMap.values());

    for (const handler of handlers) {
      setImmediate(() => {
        this.runHandler(handler, event);
      });
    }
  }

  /**
   * Runs a single handler with a timeout warning.
   * Uses a race between the handler promise and a 5s timer.
   * The timer only logs — it does not cancel the handler.
   */
  private runHandler(handler: (event: Event) => void | Promise<void>, event: Event): void {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      this.warnFn(
        `[event-bus] handler for event type "${event.type}" exceeded ${HANDLER_TIMEOUT_MS}ms`,
      );
    }, HANDLER_TIMEOUT_MS);

    let result: void | Promise<void>;
    try {
      result = handler(event);
    } catch (err) {
      clearTimeout(timer);
      // Swallow synchronous errors to prevent crashing the bus — the handler
      // is responsible for its own error handling. Log for visibility.
      this.warnFn(
        `[event-bus] handler for event type "${event.type}" threw synchronously: ${String(err)}`,
      );
      return;
    }

    if (result !== undefined && typeof result.then === 'function') {
      result.then(
        () => {
          if (!timedOut) {
            clearTimeout(timer);
          }
        },
        (err: unknown) => {
          if (!timedOut) {
            clearTimeout(timer);
          }
          // Log async errors for visibility without crashing.
          this.warnFn(
            `[event-bus] handler for event type "${event.type}" rejected: ${String(err)}`,
          );
        },
      );
    } else {
      // Synchronous handler completed.
      if (!timedOut) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Subscribe registers a handler for a specific event type.
   * Returns a subscription ID (UUID) that can be passed to unsubscribe().
   */
  subscribe(eventType: EventType, handler: (event: Event) => void | Promise<void>): string {
    if (!this.subs.has(eventType)) {
      this.subs.set(eventType, new Map());
    }

    const id = randomUUID();
    // Non-null assertion is safe: we ensured the map exists above.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this.subs.get(eventType)!.set(id, handler);
    this.reverseMap.set(id, eventType);
    return id;
  }

  /**
   * FilteredSubscribe registers a handler that only receives events for which
   * the filter function returns true.
   * Returns a subscription ID that can be passed to unsubscribe().
   */
  filteredSubscribe(
    eventType: EventType,
    filter: (event: Event) => boolean,
    handler: (event: Event) => void | Promise<void>,
  ): string {
    const wrapped = (event: Event): void | Promise<void> => {
      if (filter(event)) {
        return handler(event);
      }
    };
    return this.subscribe(eventType, wrapped);
  }

  /**
   * Unsubscribe removes a subscription by its ID.
   * Uses the reverse map for O(1) lookup. No-op if the ID is unknown.
   */
  unsubscribe(id: string): void {
    const eventType = this.reverseMap.get(id);
    if (eventType === undefined) {
      return;
    }

    this.reverseMap.delete(id);

    const handlerMap = this.subs.get(eventType);
    if (handlerMap !== undefined) {
      handlerMap.delete(id);
      if (handlerMap.size === 0) {
        this.subs.delete(eventType);
      }
    }
  }

  /**
   * Close marks the bus as closed. Subsequent publish() calls are no-ops.
   * In-flight setImmediate callbacks that were already queued may still run,
   * but no new dispatches are scheduled after close(). Node.js setImmediate
   * callbacks are already queued on the event loop — they complete naturally
   * without explicit draining.
   */
  close(): void {
    this.closed = true;
  }

  /** Returns true if the bus has been closed. Useful for testing. */
  isClosed(): boolean {
    return this.closed;
  }

  /** Returns the number of active subscriptions across all event types. */
  subscriptionCount(): number {
    let count = 0;
    for (const handlerMap of this.subs.values()) {
      count += handlerMap.size;
    }
    return count;
  }
}

/**
 * Creates a new InMemoryBus with default settings (console.warn for warnings).
 */
export function newEventBus(): InMemoryBus {
  return new InMemoryBus();
}

/**
 * Creates a new InMemoryBus with a custom warning function.
 * Useful for testing (capture warnings without console output).
 */
export function newEventBusWithWarn(warnFn: (message: string) => void): InMemoryBus {
  return new InMemoryBus(warnFn);
}
