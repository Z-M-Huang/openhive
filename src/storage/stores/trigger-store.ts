/**
 * Trigger dedup store — SQLite-backed implementation of ITriggerStore.
 *
 * Provides deduplication of trigger events with time-based expiry.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { ITriggerStore } from '../../domain/interfaces.js';
import * as schema from '../schema.js';

export class TriggerStore implements ITriggerStore {
  constructor(private readonly db: BetterSQLite3Database<typeof schema>) {}

  checkDedup(eventId: string, source: string): boolean {
    const row = this.db
      .select()
      .from(schema.triggerDedup)
      .where(
        and(
          eq(schema.triggerDedup.eventId, eventId),
          eq(schema.triggerDedup.source, source),
        ),
      )
      .get();

    if (!row) return false;

    const createdMs = new Date(row.createdAt).getTime();
    const expiresMs = createdMs + row.ttlSeconds * 1000;
    return Date.now() < expiresMs;
  }

  recordEvent(eventId: string, source: string, ttlSeconds: number): void {
    this.db
      .insert(schema.triggerDedup)
      .values({
        eventId,
        source,
        createdAt: new Date().toISOString(),
        ttlSeconds,
      })
      .onConflictDoUpdate({
        target: [schema.triggerDedup.eventId, schema.triggerDedup.source],
        set: {
          createdAt: new Date().toISOString(),
          ttlSeconds,
        },
      })
      .run();
  }

  cleanExpired(): number {
    const result = this.db.run(
      sql`DELETE FROM ${schema.triggerDedup}
          WHERE (strftime('%s', 'now') - strftime('%s', ${schema.triggerDedup.createdAt})) > ${schema.triggerDedup.ttlSeconds}`,
    );
    return result.changes;
  }
}
