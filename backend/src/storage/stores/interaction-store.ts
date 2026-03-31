/**
 * Interaction store — SQLite-backed implementation of IInteractionStore.
 *
 * Logs structured records of inbound/outbound channel interactions.
 */

import { eq, and, desc, inArray, or, isNull, lt } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { IInteractionStore, InteractionRecord } from '../../domain/interfaces.js';
import * as schema from '../schema.js';

export class InteractionStore implements IInteractionStore {
  constructor(private readonly db: BetterSQLite3Database<typeof schema>) {}

  log(record: InteractionRecord): void {
    this.db.insert(schema.channelInteractions).values({
      direction: record.direction,
      channelType: record.channelType,
      channelId: record.channelId,
      userId: record.userId ?? null,
      teamId: record.teamId ?? null,
      contentSnippet: record.contentSnippet?.slice(0, 2000) ?? null,
      contentLength: record.contentLength ?? null,
      durationMs: record.durationMs ?? null,
      createdAt: new Date().toISOString(),
    }).run();
  }

  getRecentByChannel(channelId: string, teamIds: string[], limit = 10): InteractionRecord[] {
    const channelFilter = eq(schema.channelInteractions.channelId, channelId);

    const teamFilter = teamIds.length > 0
      ? or(
          inArray(schema.channelInteractions.teamId, teamIds),
          isNull(schema.channelInteractions.teamId),
        )
      : undefined;

    const whereClause = teamFilter
      ? and(channelFilter, teamFilter)
      : channelFilter;

    const rows = this.db.select().from(schema.channelInteractions)
      .where(whereClause)
      .orderBy(desc(schema.channelInteractions.createdAt))
      .limit(limit)
      .all();

    return rows.reverse().map((r): InteractionRecord => ({
      direction: r.direction as 'inbound' | 'outbound',
      channelType: r.channelType,
      channelId: r.channelId,
      userId: r.userId ?? undefined,
      teamId: r.teamId ?? undefined,
      contentSnippet: r.contentSnippet ?? undefined,
      contentLength: r.contentLength ?? undefined,
      durationMs: r.durationMs ?? undefined,
      createdAt: r.createdAt,
    }));
  }

  cleanOlderThan(cutoffIso: string): number {
    const result = this.db.delete(schema.channelInteractions)
      .where(lt(schema.channelInteractions.createdAt, cutoffIso))
      .run();
    return result.changes;
  }
}
