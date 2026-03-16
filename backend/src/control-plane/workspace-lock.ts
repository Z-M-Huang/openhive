import { resolve } from 'node:path';
import { Mutex } from 'async-mutex';
import type { WorkspaceLock } from '../domain/index.js';

/** Acquire timeout in milliseconds (AC-D2). */
const ACQUIRE_TIMEOUT_MS = 30_000;

interface LockEntry {
  mutex: Mutex;
  holders: number;
}

export class WorkspaceLockImpl implements WorkspaceLock {
  private readonly locks = new Map<string, LockEntry>();

  async acquire(workspacePath: string): Promise<void> {
    const key = resolve(workspacePath);
    let entry = this.locks.get(key);
    if (!entry) {
      entry = { mutex: new Mutex(), holders: 0 };
      this.locks.set(key, entry);
    }

    // Race the mutex acquire against a 30-second timeout (AC-D2).
    // If the timeout fires first, throw a descriptive error so callers
    // can surface a meaningful message instead of hanging indefinitely.
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      const t = setTimeout(() => {
        reject(new Error(`WorkspaceLock acquire timeout after 30s for path: ${workspacePath}`));
      }, ACQUIRE_TIMEOUT_MS);
      // Allow the Node.js event loop to exit even if this timer is pending.
      if (typeof t === 'object' && t !== null && 'unref' in t) {
        (t as ReturnType<typeof setTimeout>).unref();
      }
    });

    await Promise.race([entry.mutex.acquire(), timeoutPromise]);
    entry.holders++;
  }

  release(workspacePath: string): void {
    const key = resolve(workspacePath);
    const entry = this.locks.get(key);
    if (!entry) return;
    if (!entry.mutex.isLocked()) return;
    entry.mutex.release();
    entry.holders--;
    if (entry.holders <= 0) {
      this.locks.delete(key);
    }
  }

  isLocked(workspacePath: string): boolean {
    const key = resolve(workspacePath);
    const entry = this.locks.get(key);
    if (!entry) return false;
    return entry.mutex.isLocked();
  }
}
