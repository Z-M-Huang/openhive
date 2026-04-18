/**
 * enqueue_parent_task handler — unit tests.
 *
 * Covers:
 *  - Root team failure shape (no_parent)
 *  - Payload format: [Work handoff from ${callerId}] prefix
 *  - sourceChannelId pass-through
 *  - Correlation ID auto-generation format
 *  - Deduplication: duplicate correlation_id within 5-min window rejected
 *  - Rate-cap: >5 calls/60 s per caller rejected
 */

import { describe, it, expect, vi } from 'vitest';
import { enqueueParentTask } from './enqueue-parent-task.js';
import type { EnqueueParentTaskDeps } from './enqueue-parent-task.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal deps object for a non-root caller with a given parentId. */
function makeDeps(parentId: string | null): EnqueueParentTaskDeps & { enqueueMock: ReturnType<typeof vi.fn> } {
  const enqueueMock = vi.fn().mockReturnValue('task-0001');
  return {
    taskQueue: { enqueue: enqueueMock } as never,
    orgTree: { getTeam: () => (parentId !== null ? { parentId } : { parentId: null }) } as never,
    enqueueMock,
  };
}

// ── describe: enqueue_parent_task registration and behavior ───────────────────

describe('enqueue_parent_task registration and behavior', () => {
  // ── Root team failure ───────────────────────────────────────────────────────

  it('returns { success: false, error: "no_parent" } for root teams', async () => {
    const deps = makeDeps(null);
    const result = await enqueueParentTask({ task: 'root work' }, 'root-caller', deps);
    expect(result).toEqual({ success: false, error: 'no_parent' });
    expect(deps.enqueueMock).not.toHaveBeenCalled();
  });

  it('returns { success: false, error: "no_parent" } and does not enqueue anything for root teams', async () => {
    const deps = makeDeps(null);
    await enqueueParentTask({ task: 'should not queue' }, 'root-team-2', deps);
    expect(deps.enqueueMock).not.toHaveBeenCalled();
  });

  // ── Payload format (AC-31) ─────────────────────────────────────────────────

  it('formats the parent payload using the ADR-selected prefix', async () => {
    const deps = makeDeps('parent-team');
    // Use a unique callerId to avoid rate-cap interference between tests
    await enqueueParentTask({ task: 'follow up' }, 'child-payload-test', deps, 'chan-1');
    // enqueue is called with positional args: (teamId, taskBody, priority, type, sourceChannelId, correlationId)
    const taskBody = deps.enqueueMock.mock.calls[0][1] as string;
    expect(taskBody).toMatch(/\[Work handoff from child-payload-test\]/);
    expect(taskBody).toContain('follow up');
  });

  it('prefixes every call — not just the first', async () => {
    const deps = makeDeps('parent-team');
    await enqueueParentTask({ task: 'task-A', correlation_id: 'prefix-test-A' }, 'child-prefix', deps);
    await enqueueParentTask({ task: 'task-B', correlation_id: 'prefix-test-B' }, 'child-prefix', deps);
    const firstBody = deps.enqueueMock.mock.calls[0][1] as string;
    const secondBody = deps.enqueueMock.mock.calls[1][1] as string;
    expect(firstBody).toMatch(/\[Work handoff from child-prefix\]/);
    expect(secondBody).toMatch(/\[Work handoff from child-prefix\]/);
  });

  // ── sourceChannelId pass-through (AC-32) ────────────────────────────────────

  it('passes sourceChannelId through to the parent queue entry', async () => {
    const deps = makeDeps('parent-team');
    await enqueueParentTask({ task: 'x' }, 'child-chan-test', deps, 'chan-7');
    // sourceChannelId is the 5th positional arg (index 4)
    expect(deps.enqueueMock.mock.calls[0][4]).toBe('chan-7');
  });

  it('passes undefined sourceChannelId when none is provided', async () => {
    const deps = makeDeps('parent-team');
    await enqueueParentTask({ task: 'no-channel' }, 'child-no-chan', deps);
    expect(deps.enqueueMock.mock.calls[0][4]).toBeUndefined();
  });

  // ── Correlation ID auto-generation (AC-33) ──────────────────────────────────

  it('auto-generates a structured correlation_id when none supplied', async () => {
    const deps = makeDeps('parent-team');
    const result = await enqueueParentTask({ task: 'auto-corr' }, 'child-autocorr', deps);
    expect(result.success).toBe(true);
    // Format: handoff:${callerId}:${timestamp}:${hex4}
    expect(result.correlation_id).toMatch(/^handoff:child-autocorr:\d+:[0-9a-f]{8}$/);
  });

  it('uses the caller-supplied correlation_id when present', async () => {
    const deps = makeDeps('parent-team');
    const result = await enqueueParentTask(
      { task: 'supplied-corr', correlation_id: 'my-custom-id-001' },
      'child-supplied-corr',
      deps,
    );
    expect(result.success).toBe(true);
    expect(result.correlation_id).toBe('my-custom-id-001');
    // 6th positional arg (index 5) is correlationId
    expect(deps.enqueueMock.mock.calls[0][5]).toBe('my-custom-id-001');
  });

  // ── Deduplication (AC-33) ───────────────────────────────────────────────────

  it('rejects a duplicate correlation_id used a second time within the 5-min window', async () => {
    const deps1 = makeDeps('parent-team');
    const deps2 = makeDeps('parent-team');
    const uniqueCorrelationId = `dedup-test-${Date.now()}-${Math.random()}`;

    const first = await enqueueParentTask(
      { task: 'first call', correlation_id: uniqueCorrelationId },
      'child-dedup',
      deps1,
    );
    expect(first.success).toBe(true);

    const second = await enqueueParentTask(
      { task: 'duplicate call', correlation_id: uniqueCorrelationId },
      'child-dedup',
      deps2,
    );
    expect(second.success).toBe(false);
    expect(second.error).toBe('duplicate_correlation_id');
    expect(deps2.enqueueMock).not.toHaveBeenCalled();
  });

  // ── Rate-cap (AC-33) ────────────────────────────────────────────────────────

  it('enforces a per-caller rate cap of 5 calls per 60-second window', async () => {
    // Use a unique callerId to isolate this test from any previous rate-cap state
    const callerId = `rate-cap-caller-${Date.now()}-${Math.random()}`;
    const results: Array<Awaited<ReturnType<typeof enqueueParentTask>>> = [];

    for (let i = 0; i < 6; i++) {
      const deps = makeDeps('parent-team');
      results.push(
        await enqueueParentTask(
          { task: `call ${String(i)}`, correlation_id: `rate-cap-corr-${callerId}-${String(i)}` },
          callerId,
          deps,
        ),
      );
    }

    // First 5 should succeed
    for (let i = 0; i < 5; i++) {
      expect(results[i].success, `call ${String(i)} should succeed`).toBe(true);
    }
    // 6th should be rate-limited
    expect(results[5].success).toBe(false);
    expect(results[5].error).toBe('rate_limit_exceeded');
  });

  // ── Successful enqueue shape ────────────────────────────────────────────────

  it('returns { success: true, correlation_id } on success', async () => {
    const deps = makeDeps('parent-team');
    const result = await enqueueParentTask(
      { task: 'success shape', correlation_id: `success-shape-${Date.now()}` },
      'child-success-shape',
      deps,
    );
    expect(result.success).toBe(true);
    expect(typeof result.correlation_id).toBe('string');
  });

  it('enqueues to the parent team (not the caller)', async () => {
    const deps = makeDeps('actual-parent-id');
    await enqueueParentTask(
      { task: 'target check', correlation_id: `target-corr-${Date.now()}` },
      'child-target',
      deps,
    );
    // First positional arg is the teamId
    expect(deps.enqueueMock.mock.calls[0][0]).toBe('actual-parent-id');
  });

  // ── Priority value accepts 'critical' (TaskPriority union) ─────────────────

  it('accepts "critical" as a valid priority and passes it through', async () => {
    const deps = makeDeps('parent-team');
    const result = await enqueueParentTask(
      {
        task: 'critical-priority-task',
        priority: 'critical',
        correlation_id: `critical-${Date.now()}`,
      },
      'child-critical',
      deps,
    );
    expect(result.success).toBe(true);
    // priority is the 3rd positional arg (index 2)
    expect(deps.enqueueMock.mock.calls[0][2]).toBe('critical');
  });
});
