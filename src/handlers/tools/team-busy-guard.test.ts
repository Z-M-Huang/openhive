import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { checkTeamBusy } from './team-busy-guard.js';
import { createMockTaskQueue } from '../__test-helpers.js';
import { TaskStatus } from '../../domain/types.js';
import type { TaskPriority } from '../../domain/types.js';

const FIXED_NOW = 1_700_000_000_000;

/**
 * Build a mock queue pre-populated with tasks.
 *
 * The real `createMockTaskQueue` enqueue signature is positional:
 *   enqueue(teamId, task, priority, type?, sourceChannelId?, correlationId?, options?)
 *
 * Status transitions and custom createdAt are applied after enqueue by
 * directly mutating the `tasks` array (safe — it's an in-memory array of plain
 * objects; the readonly markers are TypeScript-only).
 */
function mkQueue(
  taskDefs: Array<{ teamId: string; status: TaskStatus; priority?: TaskPriority; ageMs?: number }>,
) {
  const q = createMockTaskQueue();

  for (const def of taskDefs) {
    const id = q.enqueue(def.teamId, 'task', def.priority ?? 'high', 'delegate');

    // Advance to Running if required (dequeue already does this, but we use
    // updateStatus to keep the entry in the tasks array with Running status).
    if (def.status === TaskStatus.Running) {
      q.updateStatus(id, TaskStatus.Running);
    }

    // Explicit Pending transition — enqueue() defaults to Pending, but we
    // set it explicitly so tests don't silently pass if the default changes.
    if (def.status === TaskStatus.Pending) {
      q.updateStatus(id, TaskStatus.Pending);
    }

    // Back-date createdAt so stale-threshold calculations use FIXED_NOW.
    if (def.ageMs !== undefined) {
      const idx = q.tasks.findIndex((t) => t.id === id);
      if (idx !== -1) {
        q.tasks[idx] = {
          ...q.tasks[idx],
          createdAt: new Date(FIXED_NOW - def.ageMs).toISOString(),
        };
      }
    }
  }

  return q;
}

describe('checkTeamBusy', () => {
  it('no active tasks → proceed with empty inFlight', () => {
    const q = createMockTaskQueue();
    const r = checkTeamBusy('A', q, { policy: 'confirm' });
    expect(r.decision).toBe('proceed');
    expect(r.inFlight).toEqual([]);
  });

  it('active + allow → proceed with inFlight populated', () => {
    const q = mkQueue([{ teamId: 'A', status: TaskStatus.Pending }]);
    const r = checkTeamBusy('A', q, { policy: 'allow' });
    expect(r.decision).toBe('proceed');
    expect(r.inFlight).toHaveLength(1);
    expect(r.inFlight[0].status).toBe(TaskStatus.Pending);
  });

  it('active + skip → skip', () => {
    const q = mkQueue([{ teamId: 'A', status: TaskStatus.Running }]);
    const r = checkTeamBusy('A', q, { policy: 'skip' });
    expect(r.decision).toBe('skip');
    expect(r.inFlight).toHaveLength(1);
  });

  it('active + confirm → needs_confirmation', () => {
    const q = mkQueue([{ teamId: 'A', status: TaskStatus.Pending }]);
    const r = checkTeamBusy('A', q, { policy: 'confirm' });
    expect(r.decision).toBe('needs_confirmation');
  });

  it('replace with pending only → cancels pending, returns proceed', () => {
    const q = mkQueue([
      { teamId: 'A', status: TaskStatus.Pending },
      { teamId: 'A', status: TaskStatus.Pending },
    ]);
    const spy = vi.spyOn(q, 'updateStatus');
    const r = checkTeamBusy('A', q, { policy: 'replace', now: () => FIXED_NOW });
    expect(r.decision).toBe('proceed');
    expect(r.replacedTaskIds).toHaveLength(2);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('replace with stale running only → cancels stale, returns proceed', () => {
    const q = mkQueue([{ teamId: 'A', status: TaskStatus.Running, ageMs: 900_000 }]);
    const r = checkTeamBusy('A', q, { policy: 'replace', staleAfterMs: 600_000, now: () => FIXED_NOW });
    expect(r.decision).toBe('proceed');
    expect(r.replacedTaskIds).toHaveLength(1);
  });

  it('replace with non-stale running → needs_confirmation, cancels nothing', () => {
    const q = mkQueue([{ teamId: 'A', status: TaskStatus.Running, ageMs: 100_000 }]);
    const spy = vi.spyOn(q, 'updateStatus');
    const r = checkTeamBusy('A', q, { policy: 'replace', staleAfterMs: 600_000, now: () => FIXED_NOW });
    expect(r.decision).toBe('needs_confirmation');
    expect(r.reason).toBe('replace_targets_running_session');
    expect(spy).not.toHaveBeenCalled();
  });

  it('replace with mixed (pending + non-stale running) → needs_confirmation, nothing cancelled', () => {
    const q = mkQueue([
      { teamId: 'A', status: TaskStatus.Pending },
      { teamId: 'A', status: TaskStatus.Running, ageMs: 100_000 },
    ]);
    const spy = vi.spyOn(q, 'updateStatus');
    const r = checkTeamBusy('A', q, { policy: 'replace', staleAfterMs: 600_000, now: () => FIXED_NOW });
    expect(r.decision).toBe('needs_confirmation');
    expect(spy).not.toHaveBeenCalled();
  });

  it('replace with pending + stale running → cancels both, returns proceed', () => {
    const q = mkQueue([
      { teamId: 'A', status: TaskStatus.Pending },
      { teamId: 'A', status: TaskStatus.Running, ageMs: 900_000 },
    ]);
    const spy = vi.spyOn(q, 'updateStatus');
    const r = checkTeamBusy('A', q, { policy: 'replace', staleAfterMs: 600_000, now: () => FIXED_NOW });
    expect(r.decision).toBe('proceed');
    expect(r.replacedTaskIds).toHaveLength(2);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('age boundary: exactly staleAfterMs is NOT stale', () => {
    // ageMs === staleAfterMs → ageMs > staleAfterMs is false → not stale
    const q = mkQueue([{ teamId: 'A', status: TaskStatus.Running, ageMs: 600_000 }]);
    const r = checkTeamBusy('A', q, { policy: 'replace', staleAfterMs: 600_000, now: () => FIXED_NOW });
    expect(r.decision).toBe('needs_confirmation');
  });

  it('guard does not touch abortSession / cron overlap code', () => {
    const src = readFileSync('src/handlers/tools/team-busy-guard.ts', 'utf8');
    expect(src).not.toMatch(/abortSession|src\/triggers\//);
  });
});
