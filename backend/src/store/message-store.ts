/**
 * OpenHive Backend - Message Store
 *
 * Implements the MessageStore interface using Drizzle ORM and better-sqlite3.
 *
 * Design notes:
 *   - The messages table uses a single `timestamp` integer column (Unix ms).
 *     Drizzle's integer({ mode: 'timestamp_ms' }) converts Date ↔ integer
 *     automatically.
 *   - reader defaults to db.writer for in-memory test compatibility. When
 *     using a file-based DB with WAL mode, pass db.reader for concurrent
 *     read performance.
 *   - getLatest() fetches DESC LIMIT n, then reverses the result array to
 *     return chronological order.
 *   - deleteBefore() returns the count of deleted rows.
 *   - get() is an extra method (not in domain.MessageStore) used for testing.
 */

import { eq, gte, lt, asc, desc, and } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { DB } from './db.js';
import { messages } from './schema.js';
import type * as schema from './schema.js';

import { NotFoundError } from '../domain/errors.js';
import type { Message } from '../domain/types.js';
import type { MessageStore } from '../domain/interfaces.js';

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

/**
 * messageRowToDomain converts a Drizzle-typed row (from schema.messages) to a
 * domain Message. Drizzle's integer(mode:'timestamp_ms') maps the integer
 * column to a Date automatically.
 */
function messageRowToDomain(row: typeof messages.$inferSelect): Message {
  return {
    id: row.id,
    chat_jid: row.chat_jid,
    role: row.role,
    content: row.content,
    timestamp: row.timestamp,
  };
}

/**
 * messageToRow converts a domain Message to the Drizzle insert shape for
 * schema.messages. All fields are required in the domain type, so no empty
 * string fallbacks are needed (unlike tasks which has optional fields).
 */
function messageToRow(msg: Message): typeof messages.$inferInsert {
  return {
    id: msg.id,
    chat_jid: msg.chat_jid,
    role: msg.role,
    content: msg.content,
    timestamp: msg.timestamp,
  };
}

// ---------------------------------------------------------------------------
// MessageStoreImpl
// ---------------------------------------------------------------------------

/**
 * MessageStoreImpl implements domain.MessageStore using Drizzle ORM.
 *
 * The reader parameter defaults to db.writer. When using a file-based DB
 * with WAL mode, pass db.reader for concurrent read performance. When using
 * newInMemoryDB() in tests, always use db.writer (the two in-memory
 * connections are independent and do not share data).
 */
export class MessageStoreImpl implements MessageStore {
  private readonly writer: BetterSQLite3Database<typeof schema>;
  private readonly reader: BetterSQLite3Database<typeof schema>;

  constructor(db: DB, reader?: BetterSQLite3Database<typeof schema>) {
    this.writer = db.writer;
    // Default reader to writer so in-memory tests see consistent data.
    this.reader = reader ?? db.writer;
  }

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  /**
   * create inserts a new message into the database.
   * Implements MessageStore.create
   */
  async create(msg: Message): Promise<void> {
    this.writer.insert(messages).values(messageToRow(msg)).run();
  }

  // -------------------------------------------------------------------------
  // get
  // -------------------------------------------------------------------------

  /**
   * get retrieves a message by ID. Throws NotFoundError if it does not exist.
   * Extra method for testing (not in domain.MessageStore).
   */
  async get(id: string): Promise<Message> {
    const rows = this.reader.select().from(messages).where(eq(messages.id, id)).all();
    if (rows.length === 0) {
      throw new NotFoundError('message', id);
    }
    return messageRowToDomain(rows[0]!);
  }

  // -------------------------------------------------------------------------
  // getByChat
  // -------------------------------------------------------------------------

  /**
   * getByChat retrieves messages for a chat JID at or after the given
   * timestamp, ordered by timestamp ASC. An optional limit (> 0) caps
   * the number of returned rows.
   */
  async getByChat(chatJID: string, since: Date, limit: number): Promise<Message[]> {
    const condition = and(eq(messages.chat_jid, chatJID), gte(messages.timestamp, since));

    if (limit > 0) {
      const rows = this.reader
        .select()
        .from(messages)
        .where(condition)
        .orderBy(asc(messages.timestamp))
        .limit(limit)
        .all();
      return rows.map(messageRowToDomain);
    }

    const rows = this.reader
      .select()
      .from(messages)
      .where(condition)
      .orderBy(asc(messages.timestamp))
      .all();
    return rows.map(messageRowToDomain);
  }

  // -------------------------------------------------------------------------
  // getLatest
  // -------------------------------------------------------------------------

  /**
   * getLatest retrieves the N most recent messages for a chat, returned in
   * chronological order (oldest-first). Internally fetches DESC LIMIT n and
   * reverses the array.
   */
  async getLatest(chatJID: string, n: number): Promise<Message[]> {
    const rows = this.reader
      .select()
      .from(messages)
      .where(eq(messages.chat_jid, chatJID))
      .orderBy(desc(messages.timestamp))
      .limit(n)
      .all();

    // Reverse to chronological order (oldest first).
    return rows.reverse().map(messageRowToDomain);
  }

  // -------------------------------------------------------------------------
  // deleteByChat
  // -------------------------------------------------------------------------

  /**
   * deleteByChat removes all messages for a given chat JID.
   */
  async deleteByChat(chatJID: string): Promise<void> {
    this.writer.delete(messages).where(eq(messages.chat_jid, chatJID)).run();
  }

  // -------------------------------------------------------------------------
  // deleteBefore
  // -------------------------------------------------------------------------

  /**
   * deleteBefore removes all messages with a timestamp strictly before the
   * cutoff date. Returns the number of rows deleted.
   */
  async deleteBefore(before: Date): Promise<number> {
    const result = this.writer.delete(messages).where(lt(messages.timestamp, before)).run();
    return result.changes;
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * newMessageStore creates a MessageStoreImpl backed by the given DB.
 *
 * For file-based databases (production), pass db.reader as the second
 * argument to use the dedicated read connection for SELECT operations.
 *
 * For in-memory databases (tests), omit the reader argument — the store
 * defaults to db.writer for both reads and writes, ensuring visibility of
 * uncommitted data within the same connection.
 *
 * Example (production):
 *   const store = newMessageStore(db, db.reader);
 *
 * Example (tests):
 *   const db = newInMemoryDB();
 *   const store = newMessageStore(db);
 */
export function newMessageStore(
  db: DB,
  reader?: BetterSQLite3Database<typeof schema>,
): MessageStoreImpl {
  return new MessageStoreImpl(db, reader);
}
