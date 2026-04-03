/**
 * In-memory OrgTree backed by IOrgStore.
 *
 * Maintains a Map<string, OrgTreeNode> for O(1) lookups.
 * Delegates persistence to IOrgStore, keeps a local cache
 * for fast reads and ancestor traversal.
 */

import type { IOrgStore } from './interfaces.js';
import type { OrgTreeNode } from './types.js';

export class OrgTree {
  private readonly nodes = new Map<string, OrgTreeNode>();

  constructor(private readonly store: IOrgStore) {}

  loadFromStore(): void {
    this.nodes.clear();
    for (const node of this.store.getAll()) {
      this.nodes.set(node.teamId, node);
    }
  }

  addTeam(node: OrgTreeNode): void {
    this.store.addTeam(node);
    this.nodes.set(node.teamId, node);
  }

  removeTeam(id: string): void {
    this.store.removeTeam(id);
    this.nodes.delete(id);
  }

  getTeam(id: string): OrgTreeNode | undefined {
    return this.nodes.get(id);
  }

  getChildren(parentId: string): OrgTreeNode[] {
    const children: OrgTreeNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.parentId === parentId) {
        children.push(node);
      }
    }
    return children;
  }

  /** Returns ancestors ordered root -> parent (outermost first). */
  getAncestors(id: string): OrgTreeNode[] {
    const ancestors: OrgTreeNode[] = [];
    let current = this.nodes.get(id);

    while (current?.parentId) {
      const parent = this.nodes.get(current.parentId);
      if (!parent) break;
      ancestors.push(parent);
      current = parent;
    }

    // Collected child->root, reverse to root->parent
    return ancestors.reverse();
  }

  addScopeKeywords(teamId: string, keywords: string[]): void {
    this.store.addScopeKeywords(teamId, keywords);
  }

  removeScopeKeywords(teamId: string): void {
    this.store.removeScopeKeywords(teamId);
  }

  removeScopeKeyword(teamId: string, keyword: string): void {
    this.store.removeScopeKeyword(teamId, keyword);
  }

  getOwnScope(teamId: string): string[] {
    return this.store.getOwnScope(teamId);
  }

  getEffectiveScope(teamId: string): string[] {
    return this.store.getEffectiveScope(teamId);
  }

  isDescendant(teamId: string, ancestorId: string): boolean {
    let current = this.nodes.get(teamId);

    while (current?.parentId) {
      if (current.parentId === ancestorId) return true;
      current = this.nodes.get(current.parentId);
    }

    return false;
  }
}
