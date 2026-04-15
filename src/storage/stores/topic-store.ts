/**
 * Topic store — SQLite-backed implementation of ITopicStore.
 *
 * Manages conversation topic lifecycle: creation, state transitions,
 * activity tracking, and bulk idle marking for recovery.
 */

import { eq, and, desc } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { ITopicStore } from '../../domain/interfaces.js';
import type { TopicEntry, TopicState } from '../../domain/types.js';
import * as schema from '../schema.js';

export class TopicStore implements ITopicStore {
  constructor(private readonly db: BetterSQLite3Database<typeof schema>) {}

  create(topic: TopicEntry): void {
    this.db.insert(schema.topics).values({
      id: topic.id,
      channelId: topic.channelId,
      name: topic.name,
      description: topic.description || null,
      state: topic.state,
      createdAt: topic.createdAt,
      lastActivity: topic.lastActivity,
    }).run();
  }

  getById(id: string): TopicEntry | undefined {
    const row = this.db.select().from(schema.topics)
      .where(eq(schema.topics.id, id))
      .get();
    return row ? toEntry(row) : undefined;
  }

  getByChannel(channelId: string): TopicEntry[] {
    return this.db.select().from(schema.topics)
      .where(eq(schema.topics.channelId, channelId))
      .orderBy(desc(schema.topics.lastActivity))
      .all()
      .map(toEntry);
  }

  getActiveByChannel(channelId: string): TopicEntry[] {
    return this.db.select().from(schema.topics)
      .where(and(eq(schema.topics.channelId, channelId), eq(schema.topics.state, 'active')))
      .orderBy(desc(schema.topics.lastActivity))
      .all()
      .map(toEntry);
  }

  getIdleByChannel(channelId: string): TopicEntry[] {
    return this.db.select().from(schema.topics)
      .where(and(eq(schema.topics.channelId, channelId), eq(schema.topics.state, 'idle')))
      .orderBy(desc(schema.topics.lastActivity))
      .all()
      .map(toEntry);
  }

  updateState(topicId: string, state: TopicState): void {
    this.db.update(schema.topics)
      .set({ state })
      .where(eq(schema.topics.id, topicId))
      .run();
  }

  touchActivity(topicId: string): void {
    this.db.update(schema.topics)
      .set({ lastActivity: new Date().toISOString() })
      .where(eq(schema.topics.id, topicId))
      .run();
  }

  markAllIdle(channelId?: string): number {
    const condition = channelId
      ? and(eq(schema.topics.state, 'active'), eq(schema.topics.channelId, channelId))
      : eq(schema.topics.state, 'active');

    return this.db.update(schema.topics)
      .set({ state: 'idle' })
      .where(condition)
      .run()
      .changes;
  }
}

type TopicRow = typeof schema.topics.$inferSelect;

function toEntry(row: TopicRow): TopicEntry {
  return {
    id: row.id,
    channelId: row.channelId,
    name: row.name,
    description: row.description ?? '',
    state: row.state as TopicState,
    createdAt: row.createdAt,
    lastActivity: row.lastActivity,
  };
}
