/**
 * Window trigger handler -- fires a callback on a fixed time interval.
 *
 * Per ADR-42, the tick cadence is set by `tick_interval_ms` (default 30 000 ms).
 * When `max_ticks_per_window` is set, the handler stops after that many ticks
 * and becomes terminal (any subsequent `start()` is a no-op).
 *
 * Lifecycle rules:
 *   - `start()` after `stop()` is a no-op (handler is terminal once stopped).
 *   - Double `start()` is a no-op (only one timer per handler lifetime).
 *
 * Continuity model (AC-48): periodic fresh rounds plus memory cursors.
 * A single open stream across rounds is NOT attempted; each tick spawns a
 * fresh task and reads/writes cursor state via the memory store (AC-46).
 *
 * No-op tick policy (AC-47): if onTick returns void/undefined, no cursor write
 * happens; the handler stays registered and fires on the next interval.
 * Window close with in-flight work: the engine stops handlers at close;
 * in-flight tasks continue to completion in the task queue.
 *
 * Fields accepted but not yet enforced at the handler level:
 *  - `watch_window`: cron expression defining when polling is active. The
 *    current handler runs continuously between `start()` and `stop()`; the
 *    cron-driven window open/close state machine is scheduler-level.
 *  - `max_tokens_per_window`: hard cap on token consumption. Enforced at the
 *    engine/AI-SDK layer, not inside this handler.
 *  - `overlap_policy`: reuses trigger overlap policy; enforced at the engine
 *    (see ADR-34 overlap semantics).
 */

import type { WindowCursorSnapshot } from '../../domain/interfaces.js';
import type { WindowTriggerConfig } from '../../domain/types.js';

/**
 * Narrowed cursor store — WindowHandler only needs single-key lookup, not the
 * full IMemoryStore (teamName, key) two-param API.  Engine creates a closure
 * that binds teamName before passing this dep so WindowHandler has no routing
 * knowledge (AC-45, AC-67).
 */
export interface WindowCursorStore {
  getActive(key: string): Promise<{ value?: string | null } | null | undefined> | { value?: string | null } | null | undefined;
  save(key: string, value: string): Promise<void> | void;
}

export interface WindowHandlerDeps {
  readonly memoryStore?: WindowCursorStore;
}

const CURSOR_KEYS = ['last_scan_cursor', 'last_event_id', 'window_start_summary'] as const;

/** Default tick cadence per ADR-42 when `tick_interval_ms` is not provided. */
const DEFAULT_TICK_INTERVAL_MS = 30_000;

export class WindowHandler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private terminated = false;
  private tickCount = 0;

  constructor(
    private readonly config: WindowTriggerConfig & { subagent?: string },
    private readonly onTick: (ctx: { timestamp: number; cursors?: WindowCursorSnapshot }) => Promise<Partial<WindowCursorSnapshot> | void>,
    private readonly deps?: WindowHandlerDeps,
  ) {}

  start(): void {
    if (this.terminated || this.running) {
      return;
    }
    this.running = true;
    const intervalMs = this.config.tick_interval_ms ?? DEFAULT_TICK_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.runTick();
    }, intervalMs);
  }

  stop(): void {
    this.terminated = true;
    this.running = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  private async runTick(): Promise<void> {
    // Enforce hard cap on ticks per window occurrence (ADR-42). When reached,
    // the handler becomes terminal and refuses further start()/tick work.
    const cap = this.config.max_ticks_per_window;
    if (cap !== undefined && this.tickCount >= cap) {
      this.stop();
      return;
    }
    this.tickCount += 1;

    const timestamp = Date.now();
    const subagent = this.config.subagent;
    const store = this.deps?.memoryStore;

    // AC-46: read cursor state at tick start before enqueue
    let cursors: WindowCursorSnapshot | undefined;
    if (subagent && store) {
      cursors = await this.readCursors(subagent, store);
    }

    const result = await this.onTick({ timestamp, cursors });

    // AC-46: write cursor state at tick end if onTick returned cursor updates
    if (subagent && store && result !== undefined) {
      await this.writeCursors(subagent, store, result);
    }
  }

  private async readCursors(subagent: string, store: WindowCursorStore): Promise<WindowCursorSnapshot> {
    const snapshot: WindowCursorSnapshot = {};
    for (const cursorName of CURSOR_KEYS) {
      const key = `${subagent}:${cursorName}`;
      const entry = await store.getActive(key);
      if (entry?.value !== null && entry?.value !== undefined) {
        snapshot[cursorName] = String(entry.value);
      }
    }
    return snapshot;
  }

  private async writeCursors(
    subagent: string,
    store: WindowCursorStore,
    updates: Partial<WindowCursorSnapshot>,
  ): Promise<void> {
    for (const cursorName of CURSOR_KEYS) {
      const value = updates[cursorName];
      if (value !== undefined) {
        await store.save(`${subagent}:${cursorName}`, value);
      }
    }
  }
}
