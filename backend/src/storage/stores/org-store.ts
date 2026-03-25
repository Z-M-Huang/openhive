/**
 * Org store — SQLite-backed implementation of IOrgStore.
 *
 * Stores flat org tree rows and reconstructs hierarchy on read.
 */

import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type Database from 'better-sqlite3';
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
    this.db.delete(schema.scopeKeywords).where(eq(schema.scopeKeywords.teamId, id)).run();
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

  addScopeKeywords(teamId: string, keywords: string[]): void {
    for (const kw of keywords) {
      this.db.insert(schema.scopeKeywords)
        .values({ teamId, keyword: kw.toLowerCase().trim() })
        .onConflictDoNothing()
        .run();
    }
  }

  removeScopeKeywords(teamId: string): void {
    this.db.delete(schema.scopeKeywords)
      .where(eq(schema.scopeKeywords.teamId, teamId))
      .run();
  }

  getOwnScope(teamId: string): string[] {
    return this.db.select({ keyword: schema.scopeKeywords.keyword })
      .from(schema.scopeKeywords)
      .where(eq(schema.scopeKeywords.teamId, teamId))
      .all()
      .map(r => r.keyword);
  }

  getEffectiveScope(teamId: string): string[] {
    // Recursive CTE: team + all descendants → union of keywords
    // Uses raw SQLite because Drizzle doesn't support recursive CTEs
    const raw = (this.db as unknown as { $client: Database.Database }).$client;
    const rows = raw.prepare(`
      WITH RECURSIVE descendants AS (
        SELECT id FROM org_tree WHERE id = ?
        UNION ALL
        SELECT o.id FROM org_tree o JOIN descendants d ON o.parent_id = d.id
      )
      SELECT DISTINCT keyword FROM scope_keywords
      WHERE team_id IN (SELECT id FROM descendants)
    `).all(teamId) as { keyword: string }[];
    return rows.map(r => r.keyword);
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
