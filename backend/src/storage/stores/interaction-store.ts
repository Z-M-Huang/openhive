/**
 * Interaction store — SQLite-backed implementation of IInteractionStore.
 *
 * Logs structured records of inbound/outbound channel interactions.
 */

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
      contentSnippet: record.contentSnippet?.slice(0, 500) ?? null,
      contentLength: record.contentLength ?? null,
      durationMs: record.durationMs ?? null,
      createdAt: new Date().toISOString(),
    }).run();
  }
}
