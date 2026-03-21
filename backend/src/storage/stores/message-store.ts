/**
 * MessageStore implementation.
 *
 * @module storage/stores/message-store
 */

import { eq, and, lt, gte, desc, asc } from 'drizzle-orm';
import type { Database } from '../database.js';
import * as schema from '../schema.js';
import type { MessageStore } from '../../domain/interfaces.js';
import type { Message } from '../../domain/domain.js';

export function newMessageStore(db: Database): MessageStore {
  return {
    async create(msg: Message): Promise<void> {
      await db.enqueueWrite(() => {
        db.getDB().insert(schema.messages).values({
          id: msg.id,
          chat_jid: msg.chat_jid,
          role: msg.role,
          content: msg.content,
          type: msg.type,
          timestamp: msg.timestamp,
        }).run();
      });
    },

    async getByChat(chatJID: string, since: Date, limit: number): Promise<Message[]> {
      const sinceTs = since.getTime();
      const rows = db.getDB()
        .select()
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.chat_jid, chatJID),
            gte(schema.messages.timestamp, sinceTs),
          )
        )
        .orderBy(asc(schema.messages.timestamp))
        .limit(limit)
        .all();
      return rows as Message[];
    },

    async getLatest(chatJID: string, n: number): Promise<Message[]> {
      const rows = db.getDB()
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.chat_jid, chatJID))
        .orderBy(desc(schema.messages.timestamp))
        .limit(n)
        .all();
      // Reverse to return chronological order
      return (rows as Message[]).reverse();
    },

    async deleteByChat(chatJID: string): Promise<void> {
      await db.enqueueWrite(() => {
        db.getDB().delete(schema.messages)
          .where(eq(schema.messages.chat_jid, chatJID))
          .run();
      });
    },

    async deleteBefore(before: Date): Promise<number> {
      const ts = before.getTime();
      return db.enqueueWrite(() => {
        const result = db.getDB().delete(schema.messages)
          .where(lt(schema.messages.timestamp, ts))
          .run();
        return result.changes;
      });
    },
  };
}
