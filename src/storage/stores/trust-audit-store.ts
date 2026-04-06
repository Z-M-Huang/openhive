/**
 * Trust audit store — SQLite-backed implementation of ITrustAuditStore.
 *
 * Append-only log of trust decisions. No automatic retention or cleanup.
 */

import { eq, and, desc, gte } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { ITrustAuditStore, TrustAuditEntry } from '../../domain/interfaces.js';
import * as schema from '../schema.js';

export class TrustAuditStore implements ITrustAuditStore {
  constructor(private readonly db: BetterSQLite3Database<typeof schema>) {}

  log(entry: TrustAuditEntry): void {
    this.db.insert(schema.trustAuditLog).values({
      channelType: entry.channelType,
      channelId: entry.channelId,
      senderId: entry.senderId,
      decision: entry.decision,
      reason: entry.reason,
      createdAt: entry.createdAt,
    }).run();
  }

  query(opts: { since?: string; decision?: string; senderId?: string; limit?: number }): TrustAuditEntry[] {
    const filters = [];

    if (opts.since !== undefined) {
      filters.push(gte(schema.trustAuditLog.createdAt, opts.since));
    }
    if (opts.decision !== undefined) {
      filters.push(eq(schema.trustAuditLog.decision, opts.decision));
    }
    if (opts.senderId !== undefined) {
      filters.push(eq(schema.trustAuditLog.senderId, opts.senderId));
    }

    const base = this.db.select().from(schema.trustAuditLog);
    const filtered = filters.length > 0
      ? base.where(and(...filters))
      : base;

    const rows = filtered
      .orderBy(desc(schema.trustAuditLog.createdAt))
      .limit(opts.limit ?? 100)
      .all();

    return rows.map(toEntry);
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

type TrustAuditRow = typeof schema.trustAuditLog.$inferSelect;

function toEntry(row: TrustAuditRow): TrustAuditEntry {
  return {
    channelType: row.channelType,
    channelId: row.channelId,
    senderId: row.senderId,
    decision: row.decision,
    reason: row.reason,
    createdAt: row.createdAt,
  };
}
