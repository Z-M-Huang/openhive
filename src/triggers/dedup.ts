/**
 * Trigger deduplication -- prevents duplicate trigger events
 * by checking against an ITriggerStore backend.
 */

import type { ITriggerStore } from '../domain/interfaces.js';

const DEFAULT_TTL_SECONDS = 3600; // 1 hour

export class TriggerDedup {
  constructor(private readonly store: ITriggerStore) {}

  /**
   * Returns true if the event is a duplicate (already recorded and not expired).
   */
  check(eventId: string, source: string): boolean {
    return this.store.checkDedup(eventId, source);
  }

  /**
   * Records an event for future dedup checks.
   */
  record(eventId: string, source: string, ttlSeconds?: number): void {
    this.store.recordEvent(eventId, source, ttlSeconds ?? DEFAULT_TTL_SECONDS);
  }

  /**
   * Cleans expired entries. Returns count of deleted rows.
   */
  cleanup(): number {
    return this.store.cleanExpired();
  }
}
