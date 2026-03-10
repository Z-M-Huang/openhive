/**
 * OpenHive Backend - WorkspaceLock Implementation
 *
 * Controls concurrent access to workspace directories. Multiple agents in the
 * same container share a filesystem — without locking, concurrent writes to the
 * same file could corrupt data. Uses async-mutex internally.
 *
 * Each workspace path gets its own Mutex. Acquire returns a release function
 * that the caller must invoke when done. Throws if the lock cannot be acquired
 * within the specified timeout.
 */

import { Mutex } from 'async-mutex';
import { withTimeout } from 'async-mutex';
import { resolve } from 'node:path';
import type { WorkspaceLock } from '../domain/interfaces.js';

// ---------------------------------------------------------------------------
// WorkspaceLockImpl
// ---------------------------------------------------------------------------

export class WorkspaceLockImpl implements WorkspaceLock {
  /** Map of workspace path → Mutex instance. Created lazily on first acquire. */
  private readonly mutexes: Map<string, Mutex> = new Map();

  /**
   * Acquire an exclusive lock on a workspace subtree.
   *
   * @param workspacePath - The workspace directory path to lock.
   * @param _agentAID     - The AID of the agent requesting the lock (for logging/diagnostics).
   * @param timeoutMs     - Maximum time to wait for the lock in milliseconds.
   * @returns A release function that must be called when the lock is no longer needed.
   * @throws Error if the lock cannot be acquired within timeoutMs.
   */
  async acquire(workspacePath: string, _agentAID: string, timeoutMs: number): Promise<() => void> {
    const normalizedPath = resolve(workspacePath);
    let mutex = this.mutexes.get(normalizedPath);
    if (mutex === undefined) {
      mutex = new Mutex();
      this.mutexes.set(normalizedPath, mutex);
    }

    const timedMutex = withTimeout(mutex, timeoutMs);
    const release = await timedMutex.acquire();
    return release;
  }

  /**
   * Check if a workspace subtree is currently locked. Synchronous (in-memory check).
   */
  isLocked(workspacePath: string): boolean {
    const mutex = this.mutexes.get(resolve(workspacePath));
    if (mutex === undefined) return false;
    return mutex.isLocked();
  }
}
