import type { WorkspaceLock } from '../domain/index.js';

/**
 * Advisory workspace-level locks for concurrent access control.
 *
 * Prevents race conditions during simultaneous operations on the same workspace
 * path, including:
 * - Concurrent team creation targeting the same parent workspace
 * - Simultaneous agent definition writes to the same team workspace
 * - Overlapping scaffold and deletion operations on a workspace
 *
 * **Locking model:**
 * - Locks are keyed by absolute workspace path (normalized).
 * - Advisory only — callers must cooperate by acquiring before mutating.
 * - Uses async-mutex internally for non-blocking, fair queuing.
 * - {@link acquire} blocks until the lock is available (no timeout by default).
 * - {@link release} must be called in a finally block to prevent deadlocks.
 *
 * **Typical usage:**
 * ```ts
 * await lock.acquire('/app/workspace/teams/my-team');
 * try {
 *   // mutate workspace files
 * } finally {
 *   lock.release('/app/workspace/teams/my-team');
 * }
 * ```
 *
 * **Lifecycle:**
 * - Locks are created lazily on first {@link acquire} for a given path.
 * - Locks for removed workspaces are garbage collected after release.
 */
export class WorkspaceLockImpl implements WorkspaceLock {
  /**
   * Acquire an advisory lock for the given workspace path.
   *
   * Blocks until the lock is available. If the lock is already held by another
   * caller, this method waits in a FIFO queue (fair ordering via async-mutex).
   * Callers MUST call {@link release} in a finally block after acquiring.
   *
   * @param workspacePath - Absolute path to the workspace directory
   */
  async acquire(_workspacePath: string): Promise<void> {
    throw new Error('Not implemented');
  }

  /**
   * Release an advisory lock for the given workspace path.
   *
   * Must be called after a successful {@link acquire}. Releasing an unheld lock
   * is a no-op (defensive, avoids double-release errors). Wakes the next waiter
   * in the FIFO queue if any.
   *
   * @param workspacePath - Absolute path to the workspace directory
   */
  release(_workspacePath: string): void {
    throw new Error('Not implemented');
  }

  /**
   * Check if a workspace path is currently locked.
   *
   * This is a point-in-time check — the result may be stale by the time the
   * caller acts on it. Intended for diagnostics and monitoring, not for
   * conditional locking (use {@link acquire} instead).
   *
   * @param workspacePath - Absolute path to the workspace directory
   * @returns true if the lock is currently held
   */
  isLocked(_workspacePath: string): boolean {
    throw new Error('Not implemented');
  }
}
