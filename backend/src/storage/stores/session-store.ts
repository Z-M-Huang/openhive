/**
 * SessionStore implementation.
 *
 * @module storage/stores/session-store
 */

import { eq } from 'drizzle-orm';
import type { Database } from '../database.js';
import * as schema from '../schema.js';
import type { SessionStore } from '../../domain/interfaces.js';
import type { ChatSession } from '../../domain/domain.js';
import { NotFoundError } from '../../domain/errors.js';

export function newSessionStore(db: Database): SessionStore {
  return {
    async get(id: string): Promise<ChatSession> {
      const row = db.getDB()
        .select()
        .from(schema.chatSessions)
        .where(eq(schema.chatSessions.chat_jid, id))
        .get();
      if (!row) {
        throw new NotFoundError(`Session not found: ${id}`);
      }
      return row as ChatSession;
    },

    async upsert(session: ChatSession): Promise<void> {
      await db.enqueueWrite(() => {
        // Check if exists
        const existing = db.getDB()
          .select({ chat_jid: schema.chatSessions.chat_jid })
          .from(schema.chatSessions)
          .where(eq(schema.chatSessions.chat_jid, session.chat_jid))
          .get();

        if (existing) {
          db.getDB().update(schema.chatSessions)
            .set({
              channel_type: session.channel_type,
              last_timestamp: session.last_timestamp,
              last_agent_timestamp: session.last_agent_timestamp,
              session_id: session.session_id,
              agent_aid: session.agent_aid,
              tid: session.tid,
            })
            .where(eq(schema.chatSessions.chat_jid, session.chat_jid))
            .run();
        } else {
          db.getDB().insert(schema.chatSessions).values({
            chat_jid: session.chat_jid,
            channel_type: session.channel_type,
            last_timestamp: session.last_timestamp,
            last_agent_timestamp: session.last_agent_timestamp,
            session_id: session.session_id,
            agent_aid: session.agent_aid,
            tid: session.tid,
          }).run();
        }
      });
    },

    async delete(id: string): Promise<void> {
      await db.enqueueWrite(() => {
        db.getDB().delete(schema.chatSessions)
          .where(eq(schema.chatSessions.chat_jid, id))
          .run();
      });
    },

    async listAll(): Promise<ChatSession[]> {
      const rows = db.getDB()
        .select()
        .from(schema.chatSessions)
        .all();
      return rows as ChatSession[];
    },
  };
}
