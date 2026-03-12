import { describe, it, expect } from 'vitest';
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
});
