import { randomUUID } from 'node:crypto';
import type { BusEvent, EventBus, EventFilter, EventHandler } from '../domain/index.js';

interface Subscription {
  handler: EventHandler;
  filter?: EventFilter;
}

/**
 * In-memory pub/sub event bus with async delivery.
 *
 * Each handler is dispatched independently via `queueMicrotask`.
 * A slow or throwing handler does not block or affect other handlers.
 * No ordering guarantee across subscribers.
 */
export class EventBusImpl implements EventBus {
  private readonly subscriptions = new Map<string, Subscription>();
  private closed = false;

  publish(event: BusEvent): void {
    if (this.closed) return;

    for (const [, sub] of this.subscriptions) {
      if (sub.filter && !sub.filter(event)) continue;

      const handler = sub.handler;
      queueMicrotask(() => {
        try {
          handler(event);
        } catch (err) {
          console.error('EventBus handler error:', err);
        }
      });
    }
  }

  subscribe(handler: EventHandler): string {
    if (this.closed) return '';

    const id = randomUUID();
    this.subscriptions.set(id, { handler });
    return id;
  }

  filteredSubscribe(filter: EventFilter, handler: EventHandler): string {
    if (this.closed) return '';

    const id = randomUUID();
    this.subscriptions.set(id, { handler, filter });
    return id;
  }

  unsubscribe(subscriptionId: string): void {
    this.subscriptions.delete(subscriptionId);
  }

  close(): void {
    this.closed = true;
    this.subscriptions.clear();
  }
}
