/**
 * Vault store — SQLite-backed implementation of IVaultStore.
 *
 * Manages per-team key-value entries with optional secret marking.
 * set() performs upsert via onConflictDoUpdate on (team_name, key).
 */

import { eq, and } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { IVaultStore, VaultEntry } from '../../domain/interfaces.js';
import * as schema from '../schema.js';

export class VaultStore implements IVaultStore {
  constructor(private readonly db: BetterSQLite3Database<typeof schema>) {}

  set(teamName: string, key: string, value: string, isSecret: boolean, updatedBy?: string): VaultEntry {
    const now = new Date().toISOString();
    this.db.insert(schema.teamVault).values({
      teamName,
      key,
      value,
      isSecret: isSecret ? 1 : 0,
      updatedBy: updatedBy ?? null,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [schema.teamVault.teamName, schema.teamVault.key],
      set: {
        value,
        isSecret: isSecret ? 1 : 0,
        updatedBy: updatedBy ?? null,
        updatedAt: now,
      },
    }).run();

    return this.get(teamName, key)!;
  }

  get(teamName: string, key: string): VaultEntry | undefined {
    const row = this.db.select().from(schema.teamVault)
      .where(and(eq(schema.teamVault.teamName, teamName), eq(schema.teamVault.key, key)))
      .get();

    if (!row) return undefined;
    return toEntry(row);
  }

  list(teamName: string): VaultEntry[] {
    const rows = this.db.select().from(schema.teamVault)
      .where(eq(schema.teamVault.teamName, teamName))
      .all();

    return rows.map(toEntry);
  }

  delete(teamName: string, key: string): boolean {
    const result = this.db.delete(schema.teamVault)
      .where(and(eq(schema.teamVault.teamName, teamName), eq(schema.teamVault.key, key)))
      .run();

    return result.changes > 0;
  }

  getSecrets(teamName: string): VaultEntry[] {
    const rows = this.db.select().from(schema.teamVault)
      .where(and(eq(schema.teamVault.teamName, teamName), eq(schema.teamVault.isSecret, 1)))
      .all();

    return rows.map(toEntry);
  }

  removeByTeam(teamName: string): void {
    this.db.delete(schema.teamVault)
      .where(eq(schema.teamVault.teamName, teamName))
      .run();
  }
}

// -- helpers ----------------------------------------------------------------

type VaultRow = typeof schema.teamVault.$inferSelect;

function toEntry(row: VaultRow): VaultEntry {
  return {
    id: row.id,
    teamName: row.teamName,
    key: row.key,
    value: row.value,
    isSecret: row.isSecret === 1,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
