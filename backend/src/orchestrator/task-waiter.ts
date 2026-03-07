/**
 * OpenHive Backend - TaskWaiter
 *
 * Provides blocking wait semantics for task completion. Used by
 * dispatch_task_and_wait to hold the tool call open until the task
 * reaches a terminal state (completed, failed, cancelled, timed out).
 *
 * Race condition prevention:
 *   1. Register waiter BEFORE task dispatch.
 *   2. After dispatch, check if already terminal (fast path).
 *   3. notifyComplete is idempotent — safe to call multiple times.
 */

// ---------------------------------------------------------------------------
// TaskWaiterResult
// ---------------------------------------------------------------------------

/** Result returned when a waiter resolves. */
export interface TaskWaiterResult {
  task_id: string;
  status: string;
  result?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

export interface TaskWaiterLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Internal waiter entry
// ---------------------------------------------------------------------------

interface WaiterEntry {
  resolve: (r: TaskWaiterResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// TaskWaiter
// ---------------------------------------------------------------------------

/**
 * Manages blocking waits for task completion. Each waiter is a Promise
 * that resolves when the task reaches a terminal state or times out.
 */
export class TaskWaiter {
  private readonly waiters = new Map<string, WaiterEntry>();
  private readonly logger: TaskWaiterLogger;

  constructor(logger: TaskWaiterLogger) {
    this.logger = logger;
  }

  /**
   * Register a waiter for a task. Returns a Promise that resolves when
   * the task completes, fails, is cancelled, or times out.
   *
   * MUST be called BEFORE task dispatch to prevent race conditions.
   */
  waitForTask(taskId: string, timeoutMs: number): Promise<TaskWaiterResult> {
    // If a waiter already exists for this task, return a timeout error.
    if (this.waiters.has(taskId)) {
      return Promise.resolve({
        task_id: taskId,
        status: 'failed',
        error: 'duplicate waiter registration',
      });
    }

    this.logger.info('task waiter registered', { task_id: taskId, timeout_ms: timeoutMs });

    return new Promise<TaskWaiterResult>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(taskId);
        this.logger.warn('task waiter timed out', { task_id: taskId, timeout_ms: timeoutMs });
        resolve({
          task_id: taskId,
          status: 'timeout',
          error: `task did not complete within ${timeoutMs}ms`,
        });
      }, timeoutMs);

      this.waiters.set(taskId, { resolve, timer });
    });
  }

  /**
   * Notify that a task has reached a terminal state. Resolves the
   * corresponding waiter if one exists.
   *
   * Idempotent — safe to call even if no waiter is registered.
   *
   * @returns true if a waiter was notified, false if none existed.
   */
  notifyComplete(
    taskId: string,
    status: string,
    result?: string,
    error?: string,
  ): boolean {
    const entry = this.waiters.get(taskId);
    if (entry === undefined) {
      return false;
    }

    clearTimeout(entry.timer);
    this.waiters.delete(taskId);

    this.logger.info('task waiter notified', { task_id: taskId, status });

    entry.resolve({ task_id: taskId, status, result, error });
    return true;
  }

  /**
   * Cancel all pending waiters. Used during shutdown.
   */
  cancelAll(): void {
    for (const [taskId, entry] of this.waiters) {
      clearTimeout(entry.timer);
      entry.resolve({
        task_id: taskId,
        status: 'cancelled',
        error: 'waiter cancelled during shutdown',
      });
    }
    this.waiters.clear();
  }

  /**
   * Returns the number of active waiters (for diagnostics).
   */
  get activeCount(): number {
    return this.waiters.size;
  }
}
