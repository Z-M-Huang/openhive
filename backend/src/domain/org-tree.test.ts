/**
 * OrgTree tests (migrated from layer-3.test.ts)
 *
 * Org tree: addTeam, getTeam, getChildren, getAncestors (root->parent), isDescendant, removeTeam
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { OrgTree } from './org-tree.js';
import type { IOrgStore } from './interfaces.js';
import type { OrgTreeNode } from './types.js';
import { TeamStatus } from './types.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeNode(overrides: Partial<OrgTreeNode> & { teamId: string; name: string }): OrgTreeNode {
  return {
    parentId: null,
    status: TeamStatus.Idle,
    agents: [],
    children: [],
    ...overrides,
  };
}

/** Simple in-memory IOrgStore for testing OrgTree without SQLite. */
function createMemoryOrgStore(): IOrgStore {
  const data = new Map<string, OrgTreeNode>();

  return {
    addTeam(node: OrgTreeNode): void {
      data.set(node.teamId, node);
    },
    removeTeam(id: string): void {
      data.delete(id);
    },
    getTeam(id: string): OrgTreeNode | undefined {
      return data.get(id);
    },
    getChildren(parentId: string): OrgTreeNode[] {
      return [...data.values()].filter((n) => n.parentId === parentId);
    },
    getAncestors(id: string): OrgTreeNode[] {
      const ancestors: OrgTreeNode[] = [];
      let current = data.get(id);
      while (current?.parentId) {
        const parent = data.get(current.parentId);
        if (!parent) break;
        ancestors.push(parent);
        current = parent;
      }
      return ancestors;
    },
    getAll(): OrgTreeNode[] {
      return [...data.values()];
    },
    addScopeKeywords(): void {},
    removeScopeKeywords(): void {},
    getOwnScope(): string[] { return []; },
    getEffectiveScope(): string[] { return []; },
  };
}

// ── Org Tree ──────────────────────────────────────────────────────────────

describe('Org Tree', () => {
  let tree: OrgTree;
  let store: IOrgStore;

  beforeEach(() => {
    store = createMemoryOrgStore();
    tree = new OrgTree(store);
  });

  it('addTeam + getTeam round-trips', () => {
    const node = makeNode({ teamId: 'tid-root-001', name: 'root' });
    tree.addTeam(node);

    const result = tree.getTeam('tid-root-001');
    expect(result).toBeDefined();
    expect(result?.teamId).toBe('tid-root-001');
    expect(result?.name).toBe('root');
  });

  it('getTeam returns undefined for unknown id', () => {
    expect(tree.getTeam('nonexistent')).toBeUndefined();
  });

  it('getChildren returns direct children', () => {
    tree.addTeam(makeNode({ teamId: 'tid-parent', name: 'parent' }));
    tree.addTeam(makeNode({ teamId: 'tid-child-a', name: 'child-a', parentId: 'tid-parent' }));
    tree.addTeam(makeNode({ teamId: 'tid-child-b', name: 'child-b', parentId: 'tid-parent' }));
    tree.addTeam(makeNode({ teamId: 'tid-other', name: 'other' }));

    const children = tree.getChildren('tid-parent');
    expect(children).toHaveLength(2);
    expect(children.map((c) => c.name).sort()).toEqual(['child-a', 'child-b']);
  });

  it('getAncestors returns root -> parent order', () => {
    tree.addTeam(makeNode({ teamId: 'tid-root', name: 'root' }));
    tree.addTeam(makeNode({ teamId: 'tid-mid', name: 'mid', parentId: 'tid-root' }));
    tree.addTeam(makeNode({ teamId: 'tid-leaf', name: 'leaf', parentId: 'tid-mid' }));

    const ancestors = tree.getAncestors('tid-leaf');
    expect(ancestors).toHaveLength(2);
    // Root first (outermost), then mid (parent)
    expect(ancestors[0]?.name).toBe('root');
    expect(ancestors[1]?.name).toBe('mid');
  });

  it('getAncestors returns empty for root node', () => {
    tree.addTeam(makeNode({ teamId: 'tid-root', name: 'root' }));
    const ancestors = tree.getAncestors('tid-root');
    expect(ancestors).toHaveLength(0);
  });

  it('isDescendant returns true for child of ancestor', () => {
    tree.addTeam(makeNode({ teamId: 'tid-root', name: 'root' }));
    tree.addTeam(makeNode({ teamId: 'tid-mid', name: 'mid', parentId: 'tid-root' }));
    tree.addTeam(makeNode({ teamId: 'tid-leaf', name: 'leaf', parentId: 'tid-mid' }));

    expect(tree.isDescendant('tid-leaf', 'tid-root')).toBe(true);
    expect(tree.isDescendant('tid-leaf', 'tid-mid')).toBe(true);
    expect(tree.isDescendant('tid-mid', 'tid-root')).toBe(true);
  });

  it('isDescendant returns false for non-ancestor', () => {
    tree.addTeam(makeNode({ teamId: 'tid-a', name: 'a' }));
    tree.addTeam(makeNode({ teamId: 'tid-b', name: 'b' }));

    expect(tree.isDescendant('tid-a', 'tid-b')).toBe(false);
    expect(tree.isDescendant('tid-b', 'tid-a')).toBe(false);
  });

  it('isDescendant returns false for self', () => {
    tree.addTeam(makeNode({ teamId: 'tid-a', name: 'a' }));
    expect(tree.isDescendant('tid-a', 'tid-a')).toBe(false);
  });

  it('removeTeam removes from tree and store', () => {
    tree.addTeam(makeNode({ teamId: 'tid-rm', name: 'doomed' }));
    expect(tree.getTeam('tid-rm')).toBeDefined();

    tree.removeTeam('tid-rm');
    expect(tree.getTeam('tid-rm')).toBeUndefined();
    expect(store.getTeam('tid-rm')).toBeUndefined();
  });

  it('loadFromStore populates tree from store', () => {
    // Add directly to store, bypassing tree
    store.addTeam(makeNode({ teamId: 'tid-pre', name: 'pre-existing' }));

    // Tree shouldn't have it yet
    expect(tree.getTeam('tid-pre')).toBeUndefined();

    // Load from store
    tree.loadFromStore();
    expect(tree.getTeam('tid-pre')).toBeDefined();
    expect(tree.getTeam('tid-pre')?.name).toBe('pre-existing');
  });

  it('loadFromStore clears previous in-memory state', () => {
    tree.addTeam(makeNode({ teamId: 'tid-mem', name: 'memory-only' }));

    // Remove from store directly but not from tree's cache
    store.removeTeam('tid-mem');

    // After reload, the memory-only node should be gone
    tree.loadFromStore();
    expect(tree.getTeam('tid-mem')).toBeUndefined();
  });
});
