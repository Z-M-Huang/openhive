/**
 * shutdown_team tool tests — basic shutdown + cascade behavior.
 *
 * Migrated from phase-gates/layer-5.test.ts, plus new cascade tests.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { shutdownTeam } from './shutdown-team.js';
import { OrgTree } from '../../domain/org-tree.js';
import {
  setupServer,
  makeNode,
  createMemoryOrgStore,
  createMockTaskQueue,
} from '../__test-helpers.js';
import type { ServerFixtures } from '../__test-helpers.js';

// ── shutdown_team (via server invoker) ────────────────────────────────────

describe('shutdown_team', () => {
  let f: ServerFixtures;

  beforeEach(() => {
    f = setupServer();
    f.orgTree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    f.orgTree.addTeam(makeNode({ teamId: 'child', name: 'child', parentId: 'root' }));
  });

  it('stops session and removes from tree', async () => {
    const result = await f.server.invoke('shutdown_team', { name: 'child' }, 'root');

    expect(result).toEqual({ success: true });
    expect(f.orgTree.getTeam('child')).toBeUndefined();
    expect(f.sessionManager.terminateSession).toHaveBeenCalledWith('child');
  });

  it('rejects when caller is not parent', async () => {
    f.orgTree.addTeam(makeNode({ teamId: 'stranger', name: 'stranger' }));

    const result = await f.server.invoke('shutdown_team', { name: 'child' }, 'stranger');

    expect(result).toEqual(expect.objectContaining({ success: false }));
    // Team should still exist
    expect(f.orgTree.getTeam('child')).toBeDefined();
  });

  it('rejects when team not found', async () => {
    const result = await f.server.invoke('shutdown_team', { name: 'ghost' }, 'root');

    expect(result).toEqual(expect.objectContaining({ success: false }));
  });
});

// ── shutdown_team cascade behavior ────────────────────────────────────────

describe('shutdown_team cascade', () => {
  it('rejects when children exist (no cascade)', async () => {
    const store = createMemoryOrgStore();
    const tree = new OrgTree(store);
    tree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    tree.addTeam(makeNode({ teamId: 'parent', name: 'parent', parentId: 'root' }));
    tree.addTeam(makeNode({ teamId: 'child', name: 'child', parentId: 'parent' }));

    const sessionManager = {
      getSession: vi.fn().mockResolvedValue(null),
      terminateSession: vi.fn().mockResolvedValue(undefined),
    };
    const taskQueue = createMockTaskQueue();

    const result = await shutdownTeam(
      { name: 'parent', cascade: false },
      'root',
      { orgTree: tree, sessionManager, taskQueue },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('children');
    expect(result.error).toContain('cascade: true');
    // Parent should still exist
    expect(tree.getTeam('parent')).toBeDefined();
    expect(tree.getTeam('child')).toBeDefined();
  });

  it('cascade: true removes children depth-first', async () => {
    const store = createMemoryOrgStore();
    const tree = new OrgTree(store);
    tree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    tree.addTeam(makeNode({ teamId: 'parent', name: 'parent', parentId: 'root' }));
    tree.addTeam(makeNode({ teamId: 'child', name: 'child', parentId: 'parent' }));
    tree.addTeam(makeNode({ teamId: 'grandchild', name: 'grandchild', parentId: 'child' }));

    const terminateOrder: string[] = [];
    const sessionManager = {
      getSession: vi.fn().mockResolvedValue(null),
      terminateSession: vi.fn().mockImplementation(async (name: string) => {
        terminateOrder.push(name);
      }),
    };
    const taskQueue = createMockTaskQueue();

    const result = await shutdownTeam(
      { name: 'parent', cascade: true },
      'root',
      { orgTree: tree, sessionManager, taskQueue },
    );

    expect(result.success).toBe(true);

    // All three should be removed from tree
    expect(tree.getTeam('parent')).toBeUndefined();
    expect(tree.getTeam('child')).toBeUndefined();
    expect(tree.getTeam('grandchild')).toBeUndefined();

    // Sessions terminated in correct order (grandchild first, then child, then parent)
    expect(terminateOrder).toEqual(['grandchild', 'child', 'parent']);
  });
});
