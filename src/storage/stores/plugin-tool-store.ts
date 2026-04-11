/**
 * Plugin tool store — SQLite-backed implementation of IPluginToolStore.
 *
 * Manages per-team plugin tool metadata with verification state.
 * upsert() performs INSERT OR REPLACE via onConflictDoUpdate on (team_name, tool_name).
 */

import { eq, and } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { IPluginToolStore, PluginToolMeta, PluginToolVerification } from '../../domain/interfaces.js';
import { safeJsonParse } from '../../domain/safe-json.js';
import * as schema from '../schema.js';

export class PluginToolStore implements IPluginToolStore {
  constructor(private readonly db: BetterSQLite3Database<typeof schema>) {}

  upsert(meta: PluginToolMeta): void {
    const now = new Date().toISOString();
    this.db.insert(schema.pluginTools).values({
      teamName: meta.teamName,
      toolName: meta.toolName,
      status: meta.status,
      sourcePath: meta.sourcePath,
      sourceHash: meta.sourceHash,
      verification: JSON.stringify(meta.verification),
      verifiedAt: meta.verifiedAt ?? null,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [schema.pluginTools.teamName, schema.pluginTools.toolName],
      set: {
        status: meta.status,
        sourcePath: meta.sourcePath,
        sourceHash: meta.sourceHash,
        verification: JSON.stringify(meta.verification),
        verifiedAt: meta.verifiedAt ?? null,
        updatedAt: now,
      },
    }).run();
  }

  get(teamName: string, toolName: string): PluginToolMeta | undefined {
    const row = this.db.select().from(schema.pluginTools)
      .where(and(
        eq(schema.pluginTools.teamName, teamName),
        eq(schema.pluginTools.toolName, toolName),
      ))
      .get();
    return row ? this.#rowToMeta(row) : undefined;
  }

  getByTeam(teamName: string): PluginToolMeta[] {
    const rows = this.db.select().from(schema.pluginTools)
      .where(eq(schema.pluginTools.teamName, teamName))
      .all();
    return rows.map(r => this.#rowToMeta(r));
  }

  getAll(): PluginToolMeta[] {
    const rows = this.db.select().from(schema.pluginTools).all();
    return rows.map(r => this.#rowToMeta(r));
  }

  setStatus(teamName: string, toolName: string, status: PluginToolMeta['status']): void {
    this.db.update(schema.pluginTools)
      .set({
        status,
        updatedAt: new Date().toISOString(),
      })
      .where(and(
        eq(schema.pluginTools.teamName, teamName),
        eq(schema.pluginTools.toolName, toolName),
      ))
      .run();
  }

  remove(teamName: string, toolName: string): void {
    this.db.delete(schema.pluginTools)
      .where(and(
        eq(schema.pluginTools.teamName, teamName),
        eq(schema.pluginTools.toolName, toolName),
      ))
      .run();
  }

  removeByTeam(teamName: string): void {
    this.db.delete(schema.pluginTools)
      .where(eq(schema.pluginTools.teamName, teamName))
      .run();
  }

  #rowToMeta(row: typeof schema.pluginTools.$inferSelect): PluginToolMeta {
    return {
      teamName: row.teamName,
      toolName: row.toolName,
      status: row.status as PluginToolMeta['status'],
      sourcePath: row.sourcePath,
      sourceHash: row.sourceHash,
      verification: safeJsonParse<PluginToolVerification>(row.verification, 'plugin-tool-verification') ?? {},
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      verifiedAt: row.verifiedAt ?? null,
    };
  }
}
