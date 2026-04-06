/**
 * Sender trust store — SQLite-backed implementation of ISenderTrustStore.
 *
 * Manages sender trust records (trusted/denied) scoped by channel type and
 * optionally by channel ID. A null channelId represents a global grant.
 */

import { eq, and, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { ISenderTrustStore, SenderTrustRecord } from '../../domain/interfaces.js';
import * as schema from '../schema.js';

export class SenderTrustStore implements ISenderTrustStore {
  constructor(private readonly db: BetterSQLite3Database<typeof schema>) {}

  add(record: SenderTrustRecord): void {
    // SQLite treats NULLs as distinct in UNIQUE constraints, so ON CONFLICT
    // won't fire for rows where channel_id IS NULL.  Delete-then-insert
    // handles both the null and non-null cases correctly.
    this.remove(record.channelType, record.senderId, record.channelId);
    this.db.insert(schema.senderTrust).values({
      channelType: record.channelType,
      channelId: record.channelId ?? null,
      senderId: record.senderId,
      trustLevel: record.trustLevel,
      grantedBy: record.grantedBy,
      createdAt: record.createdAt,
    }).run();
  }

  remove(channelType: string, senderId: string, channelId?: string): void {
    const filters = [
      eq(schema.senderTrust.channelType, channelType),
      eq(schema.senderTrust.senderId, senderId),
    ];

    if (channelId !== undefined) {
      filters.push(eq(schema.senderTrust.channelId, channelId));
    } else {
      filters.push(isNull(schema.senderTrust.channelId));
    }

    this.db.delete(schema.senderTrust)
      .where(and(...filters))
      .run();
  }

  get(channelType: string, senderId: string, channelId?: string): SenderTrustRecord | undefined {
    const filters = [
      eq(schema.senderTrust.channelType, channelType),
      eq(schema.senderTrust.senderId, senderId),
    ];

    if (channelId !== undefined) {
      filters.push(eq(schema.senderTrust.channelId, channelId));
    } else {
      filters.push(isNull(schema.senderTrust.channelId));
    }

    const row = this.db.select().from(schema.senderTrust)
      .where(and(...filters))
      .get();

    if (!row) return undefined;
    return toRecord(row);
  }

  list(channelType?: string, trustLevel?: string): SenderTrustRecord[] {
    const filters = [];

    if (channelType !== undefined) {
      filters.push(eq(schema.senderTrust.channelType, channelType));
    }
    if (trustLevel !== undefined) {
      filters.push(eq(schema.senderTrust.trustLevel, trustLevel));
    }

    const query = this.db.select().from(schema.senderTrust);
    const rows = filters.length > 0
      ? query.where(and(...filters)).all()
      : query.all();

    return rows.map(toRecord);
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

type SenderTrustRow = typeof schema.senderTrust.$inferSelect;

function toRecord(row: SenderTrustRow): SenderTrustRecord {
  return {
    channelType: row.channelType,
    channelId: row.channelId ?? undefined,
    senderId: row.senderId,
    trustLevel: row.trustLevel,
    grantedBy: row.grantedBy,
    createdAt: row.createdAt,
  };
}
