/**
 * OpenHive Backend - Session Store
 *
 * Implements the SessionStore interface using Drizzle ORM and better-sqlite3.
 *
 * Design notes:
 *   - chat_jid is the PRIMARY KEY — the natural key used in every operation.
 *   - upsert() uses Drizzle's onConflictDoUpdate with target=chat_sessions.chat_jid
 *     to update channel_type, last_timestamp, last_agent_timestamp, session_id, agent_aid.
 *   - reader defaults to db.writer for in-memory test compatibility. When
 *     using a file-based DB with WAL mode, pass db.reader for concurrent
 *     read performance.
 *   - session_id and agent_aid are optional in the domain type but stored as
 *     empty strings in the DB (NOT NULL DEFAULT '').
 */

import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { DB } from './db.js';
import { chat_sessions } from './schema.js';
import type * as schema from './schema.js';

import { NotFoundError } from '../domain/errors.js';
import type { ChatSession } from '../domain/types.js';
import type { SessionStore } from '../domain/interfaces.js';

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

/**
 * sessionRowToDomain converts a Drizzle-typed row (from schema.chat_sessions)
 * to a domain ChatSession. Drizzle's integer(mode:'timestamp_ms') maps the
 * integer columns to Date automatically. Empty strings for session_id and
 * agent_aid are converted to undefined to match the optional domain fields.
 */
function sessionRowToDomain(row: typeof chat_sessions.$inferSelect): ChatSession {
  return {
    chat_jid: row.chat_jid,
    channel_type: row.channel_type,
    last_timestamp: row.last_timestamp,
    last_agent_timestamp: row.last_agent_timestamp,
    session_id: row.session_id !== '' ? row.session_id : undefined,
    agent_aid: row.agent_aid !== '' ? row.agent_aid : undefined,
  };
}

/**
 * sessionToRow converts a domain ChatSession to the Drizzle insert shape for
 * schema.chat_sessions. Optional string fields become empty strings (matching
 * the NOT NULL DEFAULT '' column constraints).
 */
function sessionToRow(session: ChatSession): typeof chat_sessions.$inferInsert {
  return {
    chat_jid: session.chat_jid,
    channel_type: session.channel_type,
    last_timestamp: session.last_timestamp,
    last_agent_timestamp: session.last_agent_timestamp,
    session_id: session.session_id ?? '',
    agent_aid: session.agent_aid ?? '',
  };
}

// ---------------------------------------------------------------------------
// SessionStoreImpl
// ---------------------------------------------------------------------------

/**
 * SessionStoreImpl implements domain.SessionStore using Drizzle ORM.
 *
 * The reader parameter defaults to db.writer. When using a file-based DB
 * with WAL mode, pass db.reader for concurrent read performance. When using
 * newInMemoryDB() in tests, always use db.writer (the two in-memory
 * connections are independent and do not share data).
 */
export class SessionStoreImpl implements SessionStore {
  private readonly writer: BetterSQLite3Database<typeof schema>;
  private readonly reader: BetterSQLite3Database<typeof schema>;

  constructor(db: DB, reader?: BetterSQLite3Database<typeof schema>) {
    this.writer = db.writer;
    // Default reader to writer so in-memory tests see consistent data.
    this.reader = reader ?? db.writer;
  }

  // -------------------------------------------------------------------------
  // get
  // -------------------------------------------------------------------------

  /**
   * get retrieves a chat session by JID. Throws NotFoundError if the session
   * does not exist.
   */
  async get(chatJID: string): Promise<ChatSession> {
    const rows = this.reader
      .select()
      .from(chat_sessions)
      .where(eq(chat_sessions.chat_jid, chatJID))
      .all();
    if (rows.length === 0) {
      throw new NotFoundError('session', chatJID);
    }
    return sessionRowToDomain(rows[0]!);
  }

  // -------------------------------------------------------------------------
  // upsert
  // -------------------------------------------------------------------------

  /**
   * upsert creates a new chat session or updates the existing one if a row
   * with the same chat_jid already exists. The ON CONFLICT clause updates
   * channel_type, last_timestamp, last_agent_timestamp, session_id, agent_aid.
   */
  async upsert(session: ChatSession): Promise<void> {
    const row = sessionToRow(session);
    this.writer
      .insert(chat_sessions)
      .values(row)
      .onConflictDoUpdate({
        target: chat_sessions.chat_jid,
        set: {
          channel_type: row.channel_type,
          last_timestamp: row.last_timestamp,
          last_agent_timestamp: row.last_agent_timestamp,
          session_id: row.session_id,
          agent_aid: row.agent_aid,
        },
      })
      .run();
  }

  // -------------------------------------------------------------------------
  // delete
  // -------------------------------------------------------------------------

  /**
   * delete removes a chat session by JID. Does not error if the session does
   * not exist.
   */
  async delete(chatJID: string): Promise<void> {
    this.writer.delete(chat_sessions).where(eq(chat_sessions.chat_jid, chatJID)).run();
  }

  // -------------------------------------------------------------------------
  // listAll
  // -------------------------------------------------------------------------

  /**
   * listAll returns all chat sessions.
   */
  async listAll(): Promise<ChatSession[]> {
    const rows = this.reader.select().from(chat_sessions).all();
    return rows.map(sessionRowToDomain);
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * newSessionStore creates a SessionStoreImpl backed by the given DB.
 *
 * For file-based databases (production), pass db.reader as the second
 * argument to use the dedicated read connection for SELECT operations.
 *
 * For in-memory databases (tests), omit the reader argument — the store
 * defaults to db.writer for both reads and writes, ensuring visibility of
 * uncommitted data within the same connection.
 *
 * Example (production):
 *   const store = newSessionStore(db, db.reader);
 *
 * Example (tests):
 *   const db = newInMemoryDB();
 *   const store = newSessionStore(db);
 */
export function newSessionStore(
  db: DB,
  reader?: BetterSQLite3Database<typeof schema>,
): SessionStoreImpl {
  return new SessionStoreImpl(db, reader);
}
