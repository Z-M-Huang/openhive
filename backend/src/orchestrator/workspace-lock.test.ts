/**
 * Tests for WorkspaceLockImpl (workspace-lock.ts).
 *
 * Covers:
 *   - acquire() returns a release function
 *   - isLocked() returns true when locked, false after release
 *   - Different workspace paths are tracked independently
 *   - Concurrent acquire() calls are serialized (second waits for first)
 *   - Timeout throws when lock cannot be acquired in time
 *   - Lazy mutex creation (no entry until first acquire)
 */

import { describe, it, expect } from 'vitest';
import { WorkspaceLockImpl } from './workspace-lock.js';
import type { WorkspaceLock } from '../domain/interfaces.js';

// ---------------------------------------------------------------------------
// Interface conformance
// ---------------------------------------------------------------------------

describe('WorkspaceLockImpl interface conformance', () => {
  it('satisfies the WorkspaceLock interface', () => {
    const lock: WorkspaceLock = new WorkspaceLockImpl();
    expect(typeof lock.acquire).toBe('function');
    expect(typeof lock.isLocked).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Basic lock/unlock
// ---------------------------------------------------------------------------

describe('basic lock/unlock', () => {
  it('acquire returns a release function', async () => {
    const lock = new WorkspaceLockImpl();
    const release = await lock.acquire('/workspace/team-a', 'aid-001', 5000);
    expect(typeof release).toBe('function');
    release();
  });

  it('isLocked returns false for unknown path', () => {
    const lock = new WorkspaceLockImpl();
    expect(lock.isLocked('/workspace/unknown')).toBe(false);
  });

  it('isLocked returns true when locked', async () => {
    const lock = new WorkspaceLockImpl();
    const release = await lock.acquire('/workspace/team-a', 'aid-001', 5000);
    expect(lock.isLocked('/workspace/team-a')).toBe(true);
    release();
  });

  it('isLocked returns false after release', async () => {
    const lock = new WorkspaceLockImpl();
    const release = await lock.acquire('/workspace/team-a', 'aid-001', 5000);
    release();
    expect(lock.isLocked('/workspace/team-a')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Independent path tracking
// ---------------------------------------------------------------------------

describe('independent path tracking', () => {
  it('different paths are locked independently', async () => {
    const lock = new WorkspaceLockImpl();

    const releaseA = await lock.acquire('/workspace/team-a', 'aid-001', 5000);
    expect(lock.isLocked('/workspace/team-a')).toBe(true);
    expect(lock.isLocked('/workspace/team-b')).toBe(false);

    const releaseB = await lock.acquire('/workspace/team-b', 'aid-002', 5000);
    expect(lock.isLocked('/workspace/team-a')).toBe(true);
    expect(lock.isLocked('/workspace/team-b')).toBe(true);

    releaseA();
    expect(lock.isLocked('/workspace/team-a')).toBe(false);
    expect(lock.isLocked('/workspace/team-b')).toBe(true);

    releaseB();
    expect(lock.isLocked('/workspace/team-b')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Serialization (concurrent access)
// ---------------------------------------------------------------------------

describe('serialization', () => {
  it('second acquire waits for first to release', async () => {
    const lock = new WorkspaceLockImpl();
    const order: string[] = [];

    const release1 = await lock.acquire('/workspace/team-a', 'aid-001', 5000);
    order.push('acquired-1');

    // Start second acquire (will block until first releases)
    const secondAcquire = lock.acquire('/workspace/team-a', 'aid-002', 5000).then((release2) => {
      order.push('acquired-2');
      release2();
      order.push('released-2');
    });

    // Give event loop a chance — second should NOT have acquired yet
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['acquired-1']);

    // Release first
    release1();
    order.push('released-1');

    // Wait for second to complete
    await secondAcquire;

    expect(order).toEqual(['acquired-1', 'released-1', 'acquired-2', 'released-2']);
  });
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe('timeout', () => {
  it('throws when lock cannot be acquired within timeout', async () => {
    const lock = new WorkspaceLockImpl();

    // Acquire first (holds the lock)
    const release = await lock.acquire('/workspace/team-a', 'aid-001', 5000);

    // Second acquire with very short timeout should fail
    await expect(
      lock.acquire('/workspace/team-a', 'aid-002', 1),
    ).rejects.toThrow();

    release();
  });
});

// ---------------------------------------------------------------------------
// Re-acquire after release
// ---------------------------------------------------------------------------

describe('path normalization', () => {
  it('treats equivalent paths as the same lock', async () => {
    const lock = new WorkspaceLockImpl();

    const release = await lock.acquire('/workspace/team-a/../team-a', 'aid-001', 5000);
    expect(lock.isLocked('/workspace/team-a')).toBe(true);
    release();
    expect(lock.isLocked('/workspace/team-a')).toBe(false);
  });

  it('trailing slash does not create a different lock', async () => {
    const lock = new WorkspaceLockImpl();

    // resolve() strips trailing slashes on non-root paths
    const release = await lock.acquire('/workspace/team-a/', 'aid-001', 5000);
    expect(lock.isLocked('/workspace/team-a')).toBe(true);
    release();
  });
});

describe('re-acquire', () => {
  it('can re-acquire the same path after release', async () => {
    const lock = new WorkspaceLockImpl();

    const release1 = await lock.acquire('/workspace/team-a', 'aid-001', 5000);
    release1();

    const release2 = await lock.acquire('/workspace/team-a', 'aid-001', 5000);
    expect(lock.isLocked('/workspace/team-a')).toBe(true);
    release2();
    expect(lock.isLocked('/workspace/team-a')).toBe(false);
  });
});
