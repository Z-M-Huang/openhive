/**
 * Org store — SQLite-backed implementation of IOrgStore.
 *
 * Stores flat org tree rows and reconstructs hierarchy on read.
 */

import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { IOrgStore } from '../../domain/interfaces.js';
import type { OrgTreeNode } from '../../domain/types.js';
import { TeamStatus } from '../../domain/types.js';
import * as schema from '../schema.js';

export class OrgStore implements IOrgStore {
  constructor(private readonly db: BetterSQLite3Database<typeof schema>) {}

  addTeam(node: OrgTreeNode): void {
    this.db.insert(schema.orgTree).values({
      id: node.teamId,
      name: node.name,
      parentId: node.parentId,
      status: node.status,
      createdAt: new Date().toISOString(),
    }).run();
  }

  removeTeam(id: string): void {
    this.db.delete(schema.orgTree).where(eq(schema.orgTree.id, id)).run();
  }

  getTeam(id: string): OrgTreeNode | undefined {
    const row = this.db
      .select()
      .from(schema.orgTree)
      .where(eq(schema.orgTree.id, id))
      .get();

    if (!row) return undefined;
    return this.rowToNode(row);
  }

  getChildren(parentId: string): OrgTreeNode[] {
    const rows = this.db
      .select()
      .from(schema.orgTree)
      .where(eq(schema.orgTree.parentId, parentId))
      .all();

    return rows.map((r) => this.rowToNode(r));
  }

  getAncestors(id: string): OrgTreeNode[] {
    const ancestors: OrgTreeNode[] = [];
    let current = this.getTeam(id);

    while (current?.parentId) {
      const parent = this.getTeam(current.parentId);
      if (!parent) break;
      ancestors.push(parent);
      current = parent;
    }

    return ancestors;
  }

  getAll(): OrgTreeNode[] {
    const rows = this.db.select().from(schema.orgTree).all();
    return rows.map((r) => this.rowToNode(r));
  }

  private rowToNode(row: {
    id: string;
    name: string;
    parentId: string | null;
    status: string;
    createdAt: string;
  }): OrgTreeNode {
    return {
      teamId: row.id,
      name: row.name,
      parentId: row.parentId,
      status: (row.status as TeamStatus) || TeamStatus.Idle,
      agents: [],
      children: [],
    };
  }
}
