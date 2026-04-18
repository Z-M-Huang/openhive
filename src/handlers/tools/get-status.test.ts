/**
 * get_status tool tests.
 *
 * Migrated from phase-gates/layer-5.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { setupServer, makeNode } from '../__test-helpers.js';
import type { ServerFixtures } from '../__test-helpers.js';
import { getStatus } from './get-status.js';
import { ConcurrencyManager } from '../../domain/concurrency-manager.js';

describe('get_status', () => {
  let f: ServerFixtures;

  beforeEach(() => {
    f = setupServer();
    f.orgTree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    f.orgTree.addTeam(makeNode({ teamId: 'team-a', name: 'team-a', parentId: 'root' }));
    f.orgTree.addTeam(makeNode({ teamId: 'team-b', name: 'team-b', parentId: 'root' }));
  });

  it('returns all children when no team specified', async () => {
    const result = await f.server.invoke('get_status', {}, 'root');

    const typed = result as { success: boolean; teams: Array<{ teamId: string }> };
    expect(typed.success).toBe(true);
    expect(typed.teams).toHaveLength(2);
    const ids = typed.teams.map((t) => t.teamId).sort();
    expect(ids).toEqual(['team-a', 'team-b']);
  });

  it('returns specific child team status', async () => {
    const result = await f.server.invoke('get_status', { team: 'team-a' }, 'root');

    const typed = result as { success: boolean; teams: Array<{ teamId: string; queue_depth: number }> };
    expect(typed.success).toBe(true);
    expect(typed.teams).toHaveLength(1);
    expect(typed.teams[0].teamId).toBe('team-a');
    expect(typed.teams[0].queue_depth).toBe(0);
  });

  it('shows correct queue depth and pending tasks', async () => {
    f.taskQueue.enqueue('team-a', 'task 1', 'normal', 'delegate');
    f.taskQueue.enqueue('team-a', 'task 2', 'high', 'delegate');
    f.taskQueue.enqueue('team-b', 'task 3', 'normal', 'delegate');

    const result = await f.server.invoke('get_status', { team: 'team-a' }, 'root');

    const typed = result as { success: boolean; teams: Array<{ queue_depth: number; pending_tasks: string[] }> };
    expect(typed.teams[0].queue_depth).toBe(2);
    expect(typed.teams[0].pending_tasks).toHaveLength(2);
    expect(typed.teams[0].pending_tasks).toEqual(expect.arrayContaining(['task 1', 'task 2']));
  });

  it('emits the full wiki shape per team (active_daily_ops, saturation, org_op_pending)', async () => {
    const result = await f.server.invoke('get_status', { team: 'team-a' }, 'root');

    const typed = result as { success: boolean; teams: Array<Record<string, unknown>> };
    expect(typed.success).toBe(true);
    const info = typed.teams[0];
    // Wiki §get_status: active_daily_ops, saturation (boolean), org_op_pending.
    expect(info.active_daily_ops).toBe(0);
    expect(info.saturation).toBe(false);
    expect(info.org_op_pending).toBe(false);
    expect(info.queue_depth).toBe(0);
    expect(info.pending_tasks).toEqual([]);
    expect(info.current_task).toBeNull();
  });

  it('rejects when target is not child of caller', async () => {
    f.orgTree.addTeam(makeNode({ teamId: 'stranger', name: 'stranger' }));

    const result = await f.server.invoke('get_status', { team: 'team-a' }, 'stranger');

    const typed = result as { success: boolean; error: string };
    expect(typed.success).toBe(false);
    expect(typed.error).toContain('not a child');
  });
});

// ── Live concurrency integration (ADR-41, AC-9, AC-54, AC-55, AC-59) ────────

/** Stub orgTree that exposes one child with the requested id. */
function singleChildOrgTree(childId: string, parentId: string): never {
  return {
    getChildren: (id: string) => id === parentId
      ? [{ teamId: childId, name: childId, parentId, status: 'active', agents: [], children: [] }]
      : [],
    getTeam: (id: string) => id === childId
      ? { teamId: childId, name: childId, parentId, status: 'active', agents: [], children: [] }
      : id === parentId
        ? { teamId: parentId, name: parentId, parentId: null, status: 'active', agents: [], children: [] }
        : undefined,
  } as never;
}
const emptyTaskQueue = { getByTeam: () => [] } as never;

describe('get_status reads from live concurrency manager', () => {
  it('reflects an acquired daily slot in the target team snapshot', () => {
    const mgr = new ConcurrencyManager({ maxConcurrentDailyOps: 5 });
    mgr.acquireDaily('child-a');
    mgr.acquireDaily('child-a');

    const result = getStatus(
      {},
      'parent',
      {
        orgTree: singleChildOrgTree('child-a', 'parent'),
        taskQueue: emptyTaskQueue,
        concurrencyManager: mgr,
      },
    );

    expect(result.success).toBe(true);
    expect(result.teams).toHaveLength(1);
    expect(result.teams?.[0].active_daily_ops).toBe(2);
    // 2/5 → below max → saturation is false per wiki §get_status.
    expect(result.teams?.[0].saturation).toBe(false);
  });

  it('reflects org_op_pending=true when the target team holds the org-mutex', () => {
    const mgr = new ConcurrencyManager({ maxConcurrentDailyOps: 5 });
    mgr.acquireOrg('child-a');

    const result = getStatus(
      { team: 'child-a' },
      'parent',
      {
        orgTree: singleChildOrgTree('child-a', 'parent'),
        taskQueue: emptyTaskQueue,
        concurrencyManager: mgr,
      },
    );

    expect(result.success).toBe(true);
    expect(result.teams?.[0].org_op_pending).toBe(true);
  });

  it('returns zero active_daily_ops and saturation=false when nothing is acquired', () => {
    const mgr = new ConcurrencyManager({ maxConcurrentDailyOps: 5 });

    const result = getStatus(
      { team: 'child-a' },
      'parent',
      {
        orgTree: singleChildOrgTree('child-a', 'parent'),
        taskQueue: emptyTaskQueue,
        concurrencyManager: mgr,
      },
    );

    expect(result.teams?.[0].active_daily_ops).toBe(0);
    expect(result.teams?.[0].saturation).toBe(false);
    expect(result.teams?.[0].org_op_pending).toBe(false);
  });

  it('falls back to a zeroed snapshot when no manager is injected', () => {
    const result = getStatus(
      { team: 'child-a' },
      'parent',
      {
        orgTree: singleChildOrgTree('child-a', 'parent'),
        taskQueue: emptyTaskQueue,
      },
    );

    expect(result.success).toBe(true);
    expect(result.teams?.[0].active_daily_ops).toBe(0);
    expect(result.teams?.[0].saturation).toBe(false);
    expect(result.teams?.[0].org_op_pending).toBe(false);
  });

  it('scopes snapshots per target team (one saturated child does not mask another)', () => {
    const mgr = new ConcurrencyManager({ maxConcurrentDailyOps: 1 });
    mgr.acquireDaily('child-a');

    const orgTree = {
      getChildren: (id: string) => id === 'parent'
        ? [
            { teamId: 'child-a', name: 'child-a', parentId: 'parent', status: 'active', agents: [], children: [] },
            { teamId: 'child-b', name: 'child-b', parentId: 'parent', status: 'active', agents: [], children: [] },
          ]
        : [],
      getTeam: (id: string) => ['child-a', 'child-b'].includes(id)
        ? { teamId: id, name: id, parentId: 'parent', status: 'active', agents: [], children: [] }
        : undefined,
    } as never;

    const result = getStatus(
      {},
      'parent',
      { orgTree, taskQueue: emptyTaskQueue, concurrencyManager: mgr },
    );

    const byId = new Map((result.teams ?? []).map((t) => [t.teamId, t]));
    expect(byId.get('child-a')?.saturation).toBe(true);
    expect(byId.get('child-b')?.saturation).toBe(false);
    expect(byId.get('child-a')?.active_daily_ops).toBe(1);
    expect(byId.get('child-b')?.active_daily_ops).toBe(0);
  });
});
