import { resolve } from 'node:path';
import { Mutex } from 'async-mutex';
import type { WorkspaceLock } from '../domain/index.js';

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
    await entry.mutex.acquire();
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
