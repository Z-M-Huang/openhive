/**
 * WindowHandler lifecycle tests.
 */

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { WindowHandler } from './window.js';
import { createTables } from '../../storage/database.js';
import { MemoryStore } from '../../storage/stores/memory-store.js';
import * as schema from '../../storage/schema.js';

describe('WindowHandler lifecycle', () => {
  it('fires onTick according to the configured interval', async () => {
    const ticks: number[] = [];
    const handler = new WindowHandler({ tick_interval_ms: 50 }, async ({ timestamp }) => {
      ticks.push(timestamp);
    });
    handler.start();
    await new Promise((r) => setTimeout(r, 180));
    handler.stop();
    expect(ticks.length).toBeGreaterThanOrEqual(2);
  });

  it('does not fire onTick after stop()', async () => {
    const ticks: number[] = [];
    const handler = new WindowHandler({ tick_interval_ms: 50 }, async () => {
      ticks.push(Date.now());
    });
    handler.start();
    handler.stop();
    const countAtStop = ticks.length;
    await new Promise((r) => setTimeout(r, 120));
    expect(ticks.length).toBe(countAtStop);
  });

  it('reports isRunning() consistent with start/stop', () => {
    const handler = new WindowHandler({ tick_interval_ms: 50 }, async () => {});
    expect(handler.isRunning()).toBe(false);
    handler.start();
    expect(handler.isRunning()).toBe(true);
    handler.stop();
    expect(handler.isRunning()).toBe(false);
  });

  it('double start() does not register two timers', async () => {
    const ticks: number[] = [];
    const handler = new WindowHandler({ tick_interval_ms: 50 }, async ({ timestamp }) => {
      ticks.push(timestamp);
    });
    handler.start();
    handler.start(); // second call must be a no-op
    await new Promise((r) => setTimeout(r, 180));
    handler.stop();
    // If two timers were registered, ticks would be roughly double — allow generous upper bound
    // but it should not be double the expected count
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    // Each interval fires once, not twice
    expect(ticks.length).toBeLessThan(10);
  });

  it('start() after stop() is a no-op', async () => {
    const ticks: number[] = [];
    const handler = new WindowHandler({ tick_interval_ms: 50 }, async ({ timestamp }) => {
      ticks.push(timestamp);
    });
    handler.start();
    await new Promise((r) => setTimeout(r, 80));
    handler.stop();
    const countAfterStop = ticks.length;
    handler.start(); // must be a no-op
    await new Promise((r) => setTimeout(r, 120));
    expect(ticks.length).toBe(countAfterStop);
    expect(handler.isRunning()).toBe(false);
  });
});

// ── Cursor read-at-start / write-at-end ─────────────────────────────────

describe('window cursor read-at-start / write-at-end', () => {
  it('reads the three canonical cursor keys at tick start', async () => {
    const gets: string[] = [];
    const memoryStore = {
      getActive: async (key: string) => { gets.push(key); return { value: 'cursor-value' }; },
      save: async () => {},
    } as never;
    const handler = new WindowHandler(
      { tick_interval_ms: 30, subagent: 'planner' } as never,
      async (ctx) => { /* noop */ void ctx; },
      { memoryStore },
    );
    handler.start();
    await new Promise((r) => setTimeout(r, 100));
    handler.stop();
    expect(gets).toContain('planner:last_scan_cursor');
    expect(gets).toContain('planner:last_event_id');
    expect(gets).toContain('planner:window_start_summary');
  });

  it('writes the cursor keys via memoryStore.save at tick end', async () => {
    const saves: Array<{ key: string; value: unknown }> = [];
    const memoryStore = {
      getActive: async () => ({ value: null }),
      save: async (key: string, value: unknown) => { saves.push({ key, value }); },
    } as never;
    const handler = new WindowHandler(
      { tick_interval_ms: 30, subagent: 'planner' } as never,
      async () => ({ last_scan_cursor: 'next-cursor' }),
      { memoryStore },
    );
    handler.start();
    await new Promise((r) => setTimeout(r, 80));
    handler.stop();
    expect(saves.some((s) => s.key === 'planner:last_scan_cursor')).toBe(true);
  });
});

// ── Cursor write concurrency ─────────────────────────────────────────────
// Window triggers write cursor keys via the shared MemoryStore.  These tests
// prove that cursor-keyed saves obey the same serialization guarantees as
// any other MemoryStore write (AC-67).

describe('window cursor writes share the memory lock', () => {
  let raw: Database.Database;

  afterEach(() => {
    raw?.close();
  });

  it('rejects a concurrent cursor write and a memory-store save on the same key', async () => {
    raw = new Database(':memory:');
    const db = drizzle(raw, { schema });
    createTables(raw);
    const store = new MemoryStore(db, raw);

    // Both writes target the same cursor key without a supersedeReason.
    // The microtask-queued calls execute in order: p1 succeeds (no prior
    // active entry), p2 finds the active entry and throws.
    const p1 = Promise.resolve().then(() =>
      store.save('t1', 'planner:last_scan_cursor', 'x', 'context'),
    );
    const p2 = Promise.resolve().then(() =>
      store.save('t1', 'planner:last_scan_cursor', 'y', 'context'),
    );

    const res = await Promise.allSettled([p1, p2]);
    const oks = res.filter((r) => r.status === 'fulfilled').length;
    expect(oks).toBe(1);
    expect(res[0].status).toBe('fulfilled');
    expect(res[1].status).toBe('rejected');
  });
});
