/**
 * Tests for TaskWaiter (backend/src/orchestrator/task-waiter.ts)
 *
 * Tests cover:
 *   1. waitForTask resolves when notifyComplete is called.
 *   2. waitForTask times out after the specified duration.
 *   3. notifyComplete returns false for unknown task IDs.
 *   4. Duplicate waiter registration returns error.
 *   5. cancelAll resolves all pending waiters.
 *   6. activeCount tracks pending waiters.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskWaiter } from './task-waiter.js';
import type { TaskWaiterLogger } from './task-waiter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): TaskWaiterLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaskWaiter', () => {
  let logger: TaskWaiterLogger;
  let waiter: TaskWaiter;

  beforeEach(() => {
    vi.useFakeTimers();
    logger = makeLogger();
    waiter = new TaskWaiter(logger);
  });

  afterEach(() => {
    waiter.cancelAll();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Test 1: waitForTask resolves when notifyComplete is called
  // -------------------------------------------------------------------------

  it('resolves with result when notifyComplete is called', async () => {
    const promise = waiter.waitForTask('task-1', 5000);

    const notified = waiter.notifyComplete('task-1', 'completed', 'hello world');
    expect(notified).toBe(true);

    const result = await promise;
    expect(result).toEqual({
      task_id: 'task-1',
      status: 'completed',
      result: 'hello world',
    });
  });

  it('resolves with error when notifyComplete is called with failure', async () => {
    const promise = waiter.waitForTask('task-2', 5000);

    waiter.notifyComplete('task-2', 'failed', undefined, 'something broke');

    const result = await promise;
    expect(result).toEqual({
      task_id: 'task-2',
      status: 'failed',
      error: 'something broke',
    });
  });

  // -------------------------------------------------------------------------
  // Test 2: waitForTask times out
  // -------------------------------------------------------------------------

  it('resolves with timeout status after timeout expires', async () => {
    const promise = waiter.waitForTask('task-3', 1000);

    vi.advanceTimersByTime(1000);

    const result = await promise;
    expect(result.task_id).toBe('task-3');
    expect(result.status).toBe('timeout');
    expect(result.error).toContain('1000ms');
  });

  it('logs warning on timeout', async () => {
    const promise = waiter.waitForTask('task-4', 2000);

    vi.advanceTimersByTime(2000);
    await promise;

    expect(logger.warn).toHaveBeenCalledWith(
      'task waiter timed out',
      expect.objectContaining({ task_id: 'task-4', timeout_ms: 2000 }),
    );
  });

  // -------------------------------------------------------------------------
  // Test 3: notifyComplete returns false for unknown task IDs
  // -------------------------------------------------------------------------

  it('returns false for unknown task ID', () => {
    const notified = waiter.notifyComplete('unknown', 'completed');
    expect(notified).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 4: duplicate waiter registration returns error
  // -------------------------------------------------------------------------

  it('returns error for duplicate waiter registration', async () => {
    waiter.waitForTask('task-5', 5000);
    const duplicateResult = await waiter.waitForTask('task-5', 5000);
    expect(duplicateResult.status).toBe('failed');
    expect(duplicateResult.error).toContain('duplicate');
  });

  // -------------------------------------------------------------------------
  // Test 5: cancelAll resolves all pending waiters
  // -------------------------------------------------------------------------

  it('cancelAll resolves all waiters with cancelled status', async () => {
    const p1 = waiter.waitForTask('task-6', 5000);
    const p2 = waiter.waitForTask('task-7', 5000);

    waiter.cancelAll();

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.status).toBe('cancelled');
    expect(r2.status).toBe('cancelled');
    expect(waiter.activeCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Test 6: activeCount tracks pending waiters
  // -------------------------------------------------------------------------

  it('tracks active waiter count', () => {
    expect(waiter.activeCount).toBe(0);

    waiter.waitForTask('task-8', 5000);
    expect(waiter.activeCount).toBe(1);

    waiter.waitForTask('task-9', 5000);
    expect(waiter.activeCount).toBe(2);

    waiter.notifyComplete('task-8', 'completed');
    expect(waiter.activeCount).toBe(1);

    waiter.notifyComplete('task-9', 'failed');
    expect(waiter.activeCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Idempotency: notifyComplete after timeout is safe
  // -------------------------------------------------------------------------

  it('notifyComplete after timeout returns false (already cleaned up)', async () => {
    const promise = waiter.waitForTask('task-10', 1000);
    vi.advanceTimersByTime(1000);
    await promise;

    // Waiter already timed out — notifyComplete should be a no-op.
    const notified = waiter.notifyComplete('task-10', 'completed');
    expect(notified).toBe(false);
  });
});
