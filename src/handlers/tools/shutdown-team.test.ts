/**
 * shutdown_team tool tests — basic shutdown + cascade behavior.
 *
 * Migrated from phase-gates/layer-5.test.ts, plus new cascade tests.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shutdownTeam } from './shutdown-team.js';
import { OrgTree } from '../../domain/org-tree.js';
import {
  setupServer,
  makeNode,
  createMemoryOrgStore,
  createMockTaskQueue,
  createMockEscalationStore,
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

// ── shutdown_team cleanup ────────────────────────────────────────────────

describe('shutdown_team cleanup', () => {
  it('cleans up trigger configs on shutdown', async () => {
    const store = createMemoryOrgStore();
    const tree = new OrgTree(store);
    tree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    tree.addTeam(makeNode({ teamId: 'child', name: 'child', parentId: 'root' }));

    const sessionManager = {
      getSession: vi.fn().mockResolvedValue(null),
      terminateSession: vi.fn().mockResolvedValue(undefined),
    };
    const taskQueue = createMockTaskQueue();
    const triggerConfigStore = { removeByTeam: vi.fn() };

    const result = await shutdownTeam(
      { name: 'child', cascade: false },
      'root',
      { orgTree: tree, sessionManager, taskQueue, triggerConfigStore },
    );

    expect(result.success).toBe(true);
    expect(triggerConfigStore.removeByTeam).toHaveBeenCalledWith('child');
  });

  it('cleans up task queue on shutdown', async () => {
    const store = createMemoryOrgStore();
    const tree = new OrgTree(store);
    tree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    tree.addTeam(makeNode({ teamId: 'child', name: 'child', parentId: 'root' }));

    const sessionManager = {
      getSession: vi.fn().mockResolvedValue(null),
      terminateSession: vi.fn().mockResolvedValue(undefined),
    };
    const taskQueue = createMockTaskQueue();
    vi.spyOn(taskQueue, 'removeByTeam');

    const result = await shutdownTeam(
      { name: 'child', cascade: false },
      'root',
      { orgTree: tree, sessionManager, taskQueue },
    );

    expect(result.success).toBe(true);
    expect(taskQueue.removeByTeam).toHaveBeenCalledWith('child');
  });

  it('cleans up escalation correlations on shutdown', async () => {
    const store = createMemoryOrgStore();
    const tree = new OrgTree(store);
    tree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    tree.addTeam(makeNode({ teamId: 'child', name: 'child', parentId: 'root' }));

    const sessionManager = {
      getSession: vi.fn().mockResolvedValue(null),
      terminateSession: vi.fn().mockResolvedValue(undefined),
    };
    const taskQueue = createMockTaskQueue();
    const escalationStore = createMockEscalationStore();
    vi.spyOn(escalationStore, 'removeByTeam');

    const result = await shutdownTeam(
      { name: 'child', cascade: false },
      'root',
      { orgTree: tree, sessionManager, taskQueue, escalationStore },
    );

    expect(result.success).toBe(true);
    expect(escalationStore.removeByTeam).toHaveBeenCalledWith('child');
  });

  it('cleans up interactions on shutdown', async () => {
    const store = createMemoryOrgStore();
    const tree = new OrgTree(store);
    tree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    tree.addTeam(makeNode({ teamId: 'child', name: 'child', parentId: 'root' }));

    const sessionManager = {
      getSession: vi.fn().mockResolvedValue(null),
      terminateSession: vi.fn().mockResolvedValue(undefined),
    };
    const taskQueue = createMockTaskQueue();
    const interactionStore = { removeByTeam: vi.fn() };

    const result = await shutdownTeam(
      { name: 'child', cascade: false },
      'root',
      { orgTree: tree, sessionManager, taskQueue, interactionStore },
    );

    expect(result.success).toBe(true);
    expect(interactionStore.removeByTeam).toHaveBeenCalledWith('child');
  });

  it('cleans up vault secrets on shutdown', async () => {
    const store = createMemoryOrgStore();
    const tree = new OrgTree(store);
    tree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    tree.addTeam(makeNode({ teamId: 'child', name: 'child', parentId: 'root' }));

    const sessionManager = {
      getSession: vi.fn().mockResolvedValue(null),
      terminateSession: vi.fn().mockResolvedValue(undefined),
    };
    const taskQueue = createMockTaskQueue();
    const vaultStore = { removeByTeam: vi.fn() };

    const result = await shutdownTeam(
      { name: 'child', cascade: false },
      'root',
      { orgTree: tree, sessionManager, taskQueue, vaultStore },
    );

    expect(result.success).toBe(true);
    expect(vaultStore.removeByTeam).toHaveBeenCalledWith('child');
  });

  it('cleans up filesystem on shutdown', async () => {
    const store = createMemoryOrgStore();
    const tree = new OrgTree(store);
    tree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    tree.addTeam(makeNode({ teamId: 'child', name: 'child', parentId: 'root' }));

    const sessionManager = {
      getSession: vi.fn().mockResolvedValue(null),
      terminateSession: vi.fn().mockResolvedValue(undefined),
    };
    const taskQueue = createMockTaskQueue();

    const runDir = mkdtempSync(join(tmpdir(), 'openhive-test-'));
    const teamDir = join(runDir, 'teams', 'child');
    mkdirSync(teamDir, { recursive: true });
    expect(existsSync(teamDir)).toBe(true);

    const result = await shutdownTeam(
      { name: 'child', cascade: false },
      'root',
      { orgTree: tree, sessionManager, taskQueue, runDir },
    );

    expect(result.success).toBe(true);
    expect(existsSync(teamDir)).toBe(false);
  });

  it('optional deps missing does not throw', async () => {
    const store = createMemoryOrgStore();
    const tree = new OrgTree(store);
    tree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    tree.addTeam(makeNode({ teamId: 'child', name: 'child', parentId: 'root' }));

    const sessionManager = {
      getSession: vi.fn().mockResolvedValue(null),
      terminateSession: vi.fn().mockResolvedValue(undefined),
    };
    const taskQueue = createMockTaskQueue();

    const result = await shutdownTeam(
      { name: 'child', cascade: false },
      'root',
      { orgTree: tree, sessionManager, taskQueue },
    );

    expect(result.success).toBe(true);
  });

  it('cascade cleans all descendants', async () => {
    const store = createMemoryOrgStore();
    const tree = new OrgTree(store);
    tree.addTeam(makeNode({ teamId: 'root', name: 'root' }));
    tree.addTeam(makeNode({ teamId: 'parent', name: 'parent', parentId: 'root' }));
    tree.addTeam(makeNode({ teamId: 'child', name: 'child', parentId: 'parent' }));
    tree.addTeam(makeNode({ teamId: 'grandchild', name: 'grandchild', parentId: 'child' }));

    const sessionManager = {
      getSession: vi.fn().mockResolvedValue(null),
      terminateSession: vi.fn().mockResolvedValue(undefined),
    };
    const taskQueue = createMockTaskQueue();
    const triggerConfigStore = { removeByTeam: vi.fn() };

    const result = await shutdownTeam(
      { name: 'parent', cascade: true },
      'root',
      { orgTree: tree, sessionManager, taskQueue, triggerConfigStore },
    );

    expect(result.success).toBe(true);
    expect(triggerConfigStore.removeByTeam).toHaveBeenCalledTimes(3);
    expect(triggerConfigStore.removeByTeam).toHaveBeenCalledWith('grandchild');
    expect(triggerConfigStore.removeByTeam).toHaveBeenCalledWith('child');
    expect(triggerConfigStore.removeByTeam).toHaveBeenCalledWith('parent');
  });
});
