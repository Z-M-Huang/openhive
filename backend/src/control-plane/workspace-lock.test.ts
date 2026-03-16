import { describe, it, expect, vi, afterEach } from 'vitest';
import { WorkspaceLockImpl } from './workspace-lock.js';

describe('WorkspaceLockImpl', () => {
  it('sequential acquire/release cycle works', async () => {
    const lock = new WorkspaceLockImpl();
    await lock.acquire('/app/workspace');
    expect(lock.isLocked('/app/workspace')).toBe(true);
    lock.release('/app/workspace');
    expect(lock.isLocked('/app/workspace')).toBe(false);
    await lock.acquire('/app/workspace');
    expect(lock.isLocked('/app/workspace')).toBe(true);
    lock.release('/app/workspace');
  });

  it('concurrent acquire on same path serializes access', async () => {
    const lock = new WorkspaceLockImpl();
    const order: number[] = [];

    await lock.acquire('/app/workspace');

    const second = lock.acquire('/app/workspace').then(() => {
      order.push(2);
      lock.release('/app/workspace');
    });

    // First holder does work, then releases
    order.push(1);
    lock.release('/app/workspace');

    await second;
    expect(order).toEqual([1, 2]);
  });

  it('release wakes next waiter', async () => {
    const lock = new WorkspaceLockImpl();
    let secondAcquired = false;

    await lock.acquire('/app/workspace');

    const waiter = lock.acquire('/app/workspace').then(() => {
      secondAcquired = true;
      lock.release('/app/workspace');
    });

    expect(secondAcquired).toBe(false);
    lock.release('/app/workspace');
    await waiter;
    expect(secondAcquired).toBe(true);
  });

  it('isLocked returns false for unlocked path, true for locked', async () => {
    const lock = new WorkspaceLockImpl();
    expect(lock.isLocked('/app/workspace')).toBe(false);
    await lock.acquire('/app/workspace');
    expect(lock.isLocked('/app/workspace')).toBe(true);
    lock.release('/app/workspace');
    expect(lock.isLocked('/app/workspace')).toBe(false);
  });

  it('normalizes paths so equivalent paths share the same lock', async () => {
    const lock = new WorkspaceLockImpl();
    const order: string[] = [];

    await lock.acquire('/app/workspace/teams/../teams/foo');

    const second = lock.acquire('/app/workspace/teams/foo').then(() => {
      order.push('second');
      lock.release('/app/workspace/teams/foo');
    });

    order.push('first');
    lock.release('/app/workspace/teams/../teams/foo');
    await second;

    expect(order).toEqual(['first', 'second']);
  });

  it('different paths do not block each other', async () => {
    const lock = new WorkspaceLockImpl();
    await lock.acquire('/app/workspace/a');
    await lock.acquire('/app/workspace/b');
    expect(lock.isLocked('/app/workspace/a')).toBe(true);
    expect(lock.isLocked('/app/workspace/b')).toBe(true);
    lock.release('/app/workspace/a');
    lock.release('/app/workspace/b');
  });

  it('release of unheld lock is a no-op', () => {
    const lock = new WorkspaceLockImpl();
    expect(() => lock.release('/app/workspace/nonexistent')).not.toThrow();
  });

  describe('acquire timeout (AC-D2)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('throws timeout error when lock is held for 30s without release', async () => {
      vi.useFakeTimers();
      const lock = new WorkspaceLockImpl();

      // First caller holds the lock indefinitely
      await lock.acquire('/app/workspace/timeout-test');

      // Second caller races against the 30s timeout — capture error before it propagates
      let caughtError: Error | undefined;
      const secondAcquirePromise = lock
        .acquire('/app/workspace/timeout-test')
        .catch((err: Error) => {
          caughtError = err;
        });

      // Advance time by 30 seconds to trigger the timeout
      await vi.advanceTimersByTimeAsync(30_000);
      await secondAcquirePromise;

      expect(caughtError).toBeDefined();
      expect(caughtError?.message).toBe(
        'WorkspaceLock acquire timeout after 30s for path: /app/workspace/timeout-test'
      );

      // Cleanup: release the first lock
      lock.release('/app/workspace/timeout-test');
    });

    it('succeeds without timeout when lock is released before 30s', async () => {
      vi.useFakeTimers();
      const lock = new WorkspaceLockImpl();

      await lock.acquire('/app/workspace/fast-test');

      let acquired = false;
      const secondAcquirePromise = lock.acquire('/app/workspace/fast-test').then(() => {
        acquired = true;
        lock.release('/app/workspace/fast-test');
      });

      // Advance only 1 second then release the first holder — well within timeout
      await vi.advanceTimersByTimeAsync(1_000);
      lock.release('/app/workspace/fast-test');

      // Let the second acquire settle (timer cancelled, mutex granted)
      await secondAcquirePromise;

      expect(acquired).toBe(true);
    });
  });
});
