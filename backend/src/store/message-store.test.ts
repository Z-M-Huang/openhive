/**
 * Tests for MessageStoreImpl.
 *
 * Uses newInMemoryDB() so every test runs against a clean, isolated SQLite
 * database. Because the in-memory reader and writer are separate connections
 * that cannot share data, the store is created WITHOUT a separate reader —
 * this causes the store to use db.writer for both reads and writes, ensuring
 * test visibility of newly inserted rows.
 *
 * Covers:
 *   - Create and retrieve messages by ID
 *   - Get throws NotFoundError for missing ID
 *   - GetByChat filters by chat_jid and since timestamp
 *   - GetByChat respects optional limit
 *   - GetLatest returns N most recent in chronological order
 *   - DeleteByChat removes all messages for a JID
 *   - DeleteBefore removes old messages and returns count
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { newInMemoryDB } from './db.js';
import { newMessageStore } from './message-store.js';
import { NotFoundError } from '../domain/errors.js';
import type { DB } from './db.js';
import type { MessageStoreImpl } from './message-store.js';
import type { Message } from '../domain/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let db: DB;
let store: MessageStoreImpl;

beforeEach(() => {
  db = newInMemoryDB();
  store = newMessageStore(db);
});

afterEach(() => {
  db.close();
});

/**
 * makeMessage builds a minimal valid Message for tests.
 * timestamp defaults to a predictable Unix-ms value to allow ordering
 * assertions.
 */
function makeMessage(overrides: Partial<Message> & { id: string }): Message {
  return {
    id: overrides.id,
    chat_jid: overrides.chat_jid ?? 'jid:test@s.whatsapp.net',
    role: overrides.role ?? 'user',
    content: overrides.content ?? 'hello',
    timestamp: overrides.timestamp ?? new Date(1_000_000),
  };
}

// ---------------------------------------------------------------------------
// Create and retrieve messages
// ---------------------------------------------------------------------------

describe('create and get', () => {
  it('creates a message and retrieves it by ID', async () => {
    const msg = makeMessage({ id: 'msg-1' });
    await store.create(msg);

    const retrieved = await store.get('msg-1');
    expect(retrieved.id).toBe('msg-1');
    expect(retrieved.chat_jid).toBe('jid:test@s.whatsapp.net');
    expect(retrieved.role).toBe('user');
    expect(retrieved.content).toBe('hello');
    expect(retrieved.timestamp.getTime()).toBe(1_000_000);
  });

  it('round-trips all fields correctly', async () => {
    const msg = makeMessage({
      id: 'msg-full',
      chat_jid: 'jid:chat@g.us',
      role: 'assistant',
      content: 'how can I help?',
      timestamp: new Date(9_999_999),
    });
    await store.create(msg);

    const retrieved = await store.get('msg-full');
    expect(retrieved.chat_jid).toBe('jid:chat@g.us');
    expect(retrieved.role).toBe('assistant');
    expect(retrieved.content).toBe('how can I help?');
    expect(retrieved.timestamp.getTime()).toBe(9_999_999);
  });
});

// ---------------------------------------------------------------------------
// Get throws NotFoundError for missing ID
// ---------------------------------------------------------------------------

describe('get — not found', () => {
  it('throws NotFoundError when the message does not exist', async () => {
    await expect(store.get('does-not-exist')).rejects.toThrow(NotFoundError);
  });

  it('includes the resource and ID in the error', async () => {
    let caught: NotFoundError | undefined;
    try {
      await store.get('missing-id');
    } catch (e) {
      if (e instanceof NotFoundError) caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught!.resource).toBe('message');
    expect(caught!.id).toBe('missing-id');
    expect(caught!.message).toBe('message not found: missing-id');
  });
});

// ---------------------------------------------------------------------------
// GetByChat filters by chat_jid and since timestamp
// ---------------------------------------------------------------------------

describe('getByChat — since filter', () => {
  beforeEach(async () => {
    // Three messages for the same chat, one for another chat
    await store.create(
      makeMessage({ id: 'a1', chat_jid: 'jid:a', timestamp: new Date(1_000) }),
    );
    await store.create(
      makeMessage({ id: 'a2', chat_jid: 'jid:a', timestamp: new Date(2_000) }),
    );
    await store.create(
      makeMessage({ id: 'a3', chat_jid: 'jid:a', timestamp: new Date(3_000) }),
    );
    await store.create(
      makeMessage({ id: 'b1', chat_jid: 'jid:b', timestamp: new Date(1_000) }),
    );
  });

  it('returns only messages for the specified chat_jid', async () => {
    const results = await store.getByChat('jid:a', new Date(0), 0);
    expect(results).toHaveLength(3);
    expect(results.every((m) => m.chat_jid === 'jid:a')).toBe(true);
  });

  it('filters out messages before the since timestamp', async () => {
    // since = 2000ms → only a2 and a3 qualify (timestamp >= 2000)
    const results = await store.getByChat('jid:a', new Date(2_000), 0);
    expect(results).toHaveLength(2);
    expect(results.map((m) => m.id)).toContain('a2');
    expect(results.map((m) => m.id)).toContain('a3');
    expect(results.map((m) => m.id)).not.toContain('a1');
  });

  it('returns messages ordered by timestamp ASC', async () => {
    const results = await store.getByChat('jid:a', new Date(0), 0);
    expect(results.map((m) => m.id)).toEqual(['a1', 'a2', 'a3']);
  });

  it('returns empty array when no messages match', async () => {
    const results = await store.getByChat('jid:unknown', new Date(0), 0);
    expect(results).toEqual([]);
  });

  it('returns empty array when since is past all messages', async () => {
    // All messages have timestamp <= 3000; since = 99999 → no results
    const results = await store.getByChat('jid:a', new Date(99_999), 0);
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GetByChat respects optional limit
// ---------------------------------------------------------------------------

describe('getByChat — limit', () => {
  beforeEach(async () => {
    for (let i = 1; i <= 5; i++) {
      await store.create(
        makeMessage({
          id: `lim-${i}`,
          chat_jid: 'jid:limited',
          timestamp: new Date(i * 1_000),
        }),
      );
    }
  });

  it('returns all messages when limit is 0 (unlimited)', async () => {
    const results = await store.getByChat('jid:limited', new Date(0), 0);
    expect(results).toHaveLength(5);
  });

  it('limits the number of returned messages when limit > 0', async () => {
    const results = await store.getByChat('jid:limited', new Date(0), 3);
    expect(results).toHaveLength(3);
    // Ordered ASC — first 3 in chronological order
    expect(results.map((m) => m.id)).toEqual(['lim-1', 'lim-2', 'lim-3']);
  });

  it('limit of 1 returns only the oldest qualifying message', async () => {
    const results = await store.getByChat('jid:limited', new Date(0), 1);
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe('lim-1');
  });

  it('limit larger than available rows returns all rows', async () => {
    const results = await store.getByChat('jid:limited', new Date(0), 100);
    expect(results).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// GetLatest returns N most recent in chronological order
// ---------------------------------------------------------------------------

describe('getLatest', () => {
  beforeEach(async () => {
    // 5 messages, each 1 second apart
    for (let i = 1; i <= 5; i++) {
      await store.create(
        makeMessage({
          id: `latest-${i}`,
          chat_jid: 'jid:chat',
          timestamp: new Date(i * 1_000),
        }),
      );
    }
    // Extra message for a different chat — must not appear in results
    await store.create(
      makeMessage({
        id: 'other-chat',
        chat_jid: 'jid:other',
        timestamp: new Date(999_000),
      }),
    );
  });

  it('returns the N most recent messages in chronological order', async () => {
    const results = await store.getLatest('jid:chat', 3);
    // Most recent 3 are latest-3, latest-4, latest-5.
    // After reversing from DESC fetch, they come back oldest-first: 3, 4, 5.
    expect(results).toHaveLength(3);
    expect(results.map((m) => m.id)).toEqual(['latest-3', 'latest-4', 'latest-5']);
  });

  it('returns all messages when n >= message count', async () => {
    const results = await store.getLatest('jid:chat', 10);
    expect(results).toHaveLength(5);
    // Chronological order (oldest first)
    expect(results.map((m) => m.id)).toEqual([
      'latest-1',
      'latest-2',
      'latest-3',
      'latest-4',
      'latest-5',
    ]);
  });

  it('returns only messages for the specified chat_jid', async () => {
    const results = await store.getLatest('jid:chat', 5);
    expect(results.every((m) => m.chat_jid === 'jid:chat')).toBe(true);
  });

  it('returns empty array for unknown chat_jid', async () => {
    const results = await store.getLatest('jid:unknown', 5);
    expect(results).toEqual([]);
  });

  it('returns single message when n=1', async () => {
    const results = await store.getLatest('jid:chat', 1);
    expect(results).toHaveLength(1);
    // Most recent = latest-5
    expect(results[0]!.id).toBe('latest-5');
  });
});

// ---------------------------------------------------------------------------
// DeleteByChat removes all messages for a JID
// ---------------------------------------------------------------------------

describe('deleteByChat', () => {
  it('removes all messages for the specified chat_jid', async () => {
    await store.create(makeMessage({ id: 'del-a1', chat_jid: 'jid:del' }));
    await store.create(makeMessage({ id: 'del-a2', chat_jid: 'jid:del' }));
    await store.create(makeMessage({ id: 'keep-b1', chat_jid: 'jid:keep' }));

    await store.deleteByChat('jid:del');

    // Messages for deleted chat should be gone
    const deleted = await store.getByChat('jid:del', new Date(0), 0);
    expect(deleted).toEqual([]);

    // Messages for other chat must remain
    const kept = await store.getByChat('jid:keep', new Date(0), 0);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.id).toBe('keep-b1');
  });

  it('does not throw when deleting a chat with no messages', async () => {
    await expect(store.deleteByChat('jid:empty')).resolves.toBeUndefined();
  });

  it('makes get() throw NotFoundError for deleted message IDs', async () => {
    await store.create(makeMessage({ id: 'del-msg', chat_jid: 'jid:del2' }));
    await store.deleteByChat('jid:del2');
    await expect(store.get('del-msg')).rejects.toThrow(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// DeleteBefore removes old messages and returns count
// ---------------------------------------------------------------------------

describe('deleteBefore', () => {
  beforeEach(async () => {
    // Messages at t=1000, 2000, 3000, 4000, 5000
    for (let i = 1; i <= 5; i++) {
      await store.create(
        makeMessage({
          id: `prune-${i}`,
          chat_jid: 'jid:prune',
          timestamp: new Date(i * 1_000),
        }),
      );
    }
  });

  it('deletes messages with timestamp strictly before the cutoff', async () => {
    // cutoff = 3000 → delete t=1000, t=2000 (2 rows)
    const count = await store.deleteBefore(new Date(3_000));
    expect(count).toBe(2);

    const remaining = await store.getByChat('jid:prune', new Date(0), 0);
    expect(remaining).toHaveLength(3);
    expect(remaining.map((m) => m.id)).toEqual(['prune-3', 'prune-4', 'prune-5']);
  });

  it('does not delete messages at exactly the cutoff timestamp', async () => {
    // Strict less-than: timestamp < cutoff, so t=3000 is kept
    const count = await store.deleteBefore(new Date(3_000));
    const msg3 = await store.get('prune-3');
    expect(msg3).toBeDefined();
    expect(count).toBe(2);
  });

  it('returns 0 when no messages are older than the cutoff', async () => {
    const count = await store.deleteBefore(new Date(0));
    expect(count).toBe(0);
  });

  it('deletes all messages when cutoff is past all timestamps', async () => {
    const count = await store.deleteBefore(new Date(999_999));
    expect(count).toBe(5);

    const remaining = await store.getByChat('jid:prune', new Date(0), 0);
    expect(remaining).toEqual([]);
  });

  it('spans multiple chat_jids', async () => {
    // Add an old message for a different chat
    await store.create(
      makeMessage({
        id: 'cross-chat',
        chat_jid: 'jid:other',
        timestamp: new Date(500),
      }),
    );

    const count = await store.deleteBefore(new Date(1_500));
    // prune-1 (t=1000) + cross-chat (t=500) = 2 rows
    expect(count).toBe(2);
  });
});
