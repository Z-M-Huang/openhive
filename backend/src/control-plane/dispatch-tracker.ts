import type { DispatchTracker, EventBus } from '../domain/index.js';

/** Grace period before a dispatch is considered timed out and eligible for re-dispatch. */
const GRACE_PERIOD_MS = 60_000;

/**
 * Dispatch entry keyed by taskId, scoped to a container TID.
 *
 * Stores both `tid` (container ID) and `agentAid` (assigned agent).
 * The unit of re-dispatch is the TID (container boundary, per INV-02, INV-05),
 * but `agentAid` is recorded for audit, logging, and future fine-grained replay.
 * The orchestrator uses `getUnacknowledged(tid)` to bulk-replay all pending tasks
 * for a restarted container.
 */
interface DispatchEntry {
  taskId: string;
  tid: string;
  agentAid: string;
  dispatchedAt: number;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Tracks in-flight task dispatches with a 60-second grace period.
 *
 * When a task is dispatched to a container, `trackDispatch` is called. If the
 * container does not acknowledge the task (via `acknowledgeDispatch`) within the
 * grace period, a `dispatch.timeout` event is emitted on the EventBus so the
 * orchestrator can decide whether to re-dispatch.
 *
 * `stop()` cancels all pending timers — suitable for clean shutdown.
 */
export class DispatchTrackerImpl implements DispatchTracker {
  private readonly entries = new Map<string, DispatchEntry>();
  private started = false;

  constructor(private readonly eventBus: EventBus) {}

  /**
   * Record that a task was dispatched to a container identified by `tid`
   * and assigned to the agent identified by `agentAid`.
   * Starts a 60-second countdown; if the task is not acknowledged in time,
   * a `dispatch.timeout` event is published on the EventBus.
   *
   * Calling `trackDispatch` for a task that is already tracked is a no-op
   * (the existing entry and its timer remain unchanged).
   */
  trackDispatch(taskId: string, tid: string, agentAid: string): void {
    if (this.entries.has(taskId)) return;

    const timer = setTimeout(() => {
      this.entries.delete(taskId);
      this.eventBus.publish({
        type: 'dispatch.timeout',
        data: { taskId, tid, agentAid },
        timestamp: Date.now(),
        source: 'DispatchTracker',
      });
    }, GRACE_PERIOD_MS);

    this.entries.set(taskId, {
      taskId,
      tid,
      agentAid,
      dispatchedAt: Date.now(),
      timer,
    });
  }

  /**
   * Mark a dispatched task as acknowledged by the container.
   * Clears its timeout timer and removes the entry.
   * No-op if the task was not being tracked.
   */
  acknowledgeDispatch(taskId: string): void {
    const entry = this.entries.get(taskId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.entries.delete(taskId);
  }

  /**
   * Transfer dispatch ownership from an old TID to a new TID.
   * Used when a container restarts and gets a new TID (Phase 9.1).
   * The new container's `ready` message will trigger replay using the new TID.
   */
  transferOwnership(oldTid: string, newTid: string): number {
    let transferred = 0;
    for (const entry of this.entries.values()) {
      if (entry.tid === oldTid) {
        entry.tid = newTid;
        transferred++;
      }
    }
    return transferred;
  }

  /**
   * Return the task IDs dispatched to the given TID that have not yet been
   * acknowledged (i.e. still within or past the grace period but timer not
   * yet fired — or timer just started).
   */
  getUnacknowledged(tid: string): string[] {
    const result: string[] = [];
    for (const entry of this.entries.values()) {
      if (entry.tid === tid) {
        result.push(entry.taskId);
      }
    }
    return result;
  }

  /**
   * Return the task IDs assigned to the given agent AID that have not yet been
   * acknowledged. Used when an agent is explicitly removed to clear only its
   * in-flight dispatches, leaving other agents' dispatches intact.
   */
  getUnacknowledgedByAgent(agentAid: string): string[] {
    const result: string[] = [];
    for (const entry of this.entries.values()) {
      if (entry.agentAid === agentAid) {
        result.push(entry.taskId);
      }
    }
    return result;
  }

  /**
   * Start the tracker. Must be called before `trackDispatch`.
   * Idempotent — calling start() twice has no effect.
   */
  start(): void {
    this.started = true;
  }

  /**
   * Stop the tracker. Cancels all in-flight timers and clears the entry map.
   * After `stop()`, no `dispatch.timeout` events will be emitted for
   * previously tracked tasks.
   */
  stop(): void {
    for (const entry of this.entries.values()) {
      clearTimeout(entry.timer);
    }
    this.entries.clear();
    this.started = false;
  }

  /** Expose started state for testing. */
  isStarted(): boolean {
    return this.started;
  }
}
