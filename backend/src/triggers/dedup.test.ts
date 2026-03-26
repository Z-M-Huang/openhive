/**
 * UT-14: Trigger Dedup
 *
 * Tests: TriggerDedup prevents duplicate events, clean expired works, non-duplicate allows
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { TriggerDedup } from './dedup.js';
import type { ITriggerStore } from '../domain/interfaces.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function createMemoryTriggerStore(): ITriggerStore {
  const events = new Map<string, { source: string; createdAt: number; ttlSeconds: number }>();

  return {
    checkDedup(eventId: string, source: string): boolean {
      const key = `${eventId}:${source}`;
      const entry = events.get(key);
      if (!entry) return false;
      return Date.now() < entry.createdAt + entry.ttlSeconds * 1000;
    },
    recordEvent(eventId: string, source: string, ttlSeconds: number): void {
      const key = `${eventId}:${source}`;
      events.set(key, { source, createdAt: Date.now(), ttlSeconds });
    },
    cleanExpired(): number {
      const now = Date.now();
      let count = 0;
      for (const [key, entry] of events) {
        if (now >= entry.createdAt + entry.ttlSeconds * 1000) {
          events.delete(key);
          count++;
        }
      }
      return count;
    },
  };
}

// ── UT-14: Trigger Dedup ─────────────────────────────────────────────────

describe('UT-14: Trigger Dedup', () => {
  let store: ITriggerStore;
  let dedup: TriggerDedup;

  beforeEach(() => {
    store = createMemoryTriggerStore();
    dedup = new TriggerDedup(store);
  });

  it('non-duplicate returns false', () => {
    expect(dedup.check('evt-1', 'source-a')).toBe(false);
  });

  it('recorded event returns true on second check', () => {
    dedup.record('evt-1', 'source-a', 60);
    expect(dedup.check('evt-1', 'source-a')).toBe(true);
  });

  it('different event IDs are independent', () => {
    dedup.record('evt-1', 'source-a', 60);
    expect(dedup.check('evt-2', 'source-a')).toBe(false);
  });

  it('different sources are independent', () => {
    dedup.record('evt-1', 'source-a', 60);
    expect(dedup.check('evt-1', 'source-b')).toBe(false);
  });

  it('expired events are not duplicates', () => {
    vi.useFakeTimers();
    try {
      dedup.record('evt-1', 'source-a', 1); // 1 second TTL
      vi.advanceTimersByTime(2000);
      expect(dedup.check('evt-1', 'source-a')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleanup removes expired entries', () => {
    vi.useFakeTimers();
    try {
      dedup.record('evt-1', 'source-a', 1);
      vi.advanceTimersByTime(2000);
      const cleaned = dedup.cleanup();
      expect(cleaned).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleanup returns 0 when nothing expired', () => {
    dedup.record('evt-1', 'source-a', 3600);
    expect(dedup.cleanup()).toBe(0);
  });

  it('uses default TTL when not specified', () => {
    dedup.record('evt-1', 'source-a');
    expect(dedup.check('evt-1', 'source-a')).toBe(true);
  });
});
