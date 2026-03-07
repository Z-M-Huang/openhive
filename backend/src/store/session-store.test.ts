/**
 * Tests for SessionStoreImpl.
 *
 * Uses newInMemoryDB() so every test runs against a clean, isolated SQLite
 * database. Because the in-memory reader and writer are separate connections
 * that cannot share data, the store is created WITHOUT a separate reader —
 * this causes the store to use db.writer for both reads and writes, ensuring
 * test visibility of newly inserted rows.
 *
 * Covers:
 *   - Get returns session by JID
 *   - Get throws NotFoundError for missing JID
 *   - Upsert creates a new session
 *   - Upsert updates an existing session (ON CONFLICT — all five updatable columns)
 *   - Delete removes session
 *   - Delete is a no-op for non-existent JID
 *   - ListAll returns all sessions
 *   - ListAll returns empty array when no sessions exist
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { newInMemoryDB } from './db.js';
import { newSessionStore } from './session-store.js';
import { NotFoundError } from '../domain/errors.js';
import type { DB } from './db.js';
import type { SessionStoreImpl } from './session-store.js';
import type { ChatSession } from '../domain/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let db: DB;
let store: SessionStoreImpl;

beforeEach(() => {
  db = newInMemoryDB();
  store = newSessionStore(db);
});

afterEach(() => {
  db.close();
});

/**
 * makeSession builds a minimal valid ChatSession for tests.
 * Timestamps default to predictable values to allow equality assertions.
 */
function makeSession(overrides: Partial<ChatSession> & { chat_jid: string }): ChatSession {
  return {
    chat_jid: overrides.chat_jid,
    channel_type: overrides.channel_type ?? 'discord',
    last_timestamp: overrides.last_timestamp ?? new Date(1_000_000),
    last_agent_timestamp: overrides.last_agent_timestamp ?? new Date(2_000_000),
    session_id: overrides.session_id,
    agent_aid: overrides.agent_aid,
  };
}

// ---------------------------------------------------------------------------
// Get returns session by JID
// ---------------------------------------------------------------------------

describe('get — found', () => {
  it('returns the session for an existing JID', async () => {
    const session = makeSession({ chat_jid: 'jid:test@s.whatsapp.net' });
    await store.upsert(session);

    const retrieved = await store.get('jid:test@s.whatsapp.net');
    expect(retrieved.chat_jid).toBe('jid:test@s.whatsapp.net');
    expect(retrieved.channel_type).toBe('discord');
    expect(retrieved.last_timestamp.getTime()).toBe(1_000_000);
    expect(retrieved.last_agent_timestamp.getTime()).toBe(2_000_000);
  });

  it('round-trips all fields including optional ones', async () => {
    const session = makeSession({
      chat_jid: 'jid:full@g.us',
      channel_type: 'whatsapp',
      last_timestamp: new Date(3_000_000),
      last_agent_timestamp: new Date(4_000_000),
      session_id: 'sess-abc123',
      agent_aid: 'aid-xyz-789',
    });
    await store.upsert(session);

    const retrieved = await store.get('jid:full@g.us');
    expect(retrieved.chat_jid).toBe('jid:full@g.us');
    expect(retrieved.channel_type).toBe('whatsapp');
    expect(retrieved.last_timestamp.getTime()).toBe(3_000_000);
    expect(retrieved.last_agent_timestamp.getTime()).toBe(4_000_000);
    expect(retrieved.session_id).toBe('sess-abc123');
    expect(retrieved.agent_aid).toBe('aid-xyz-789');
  });

  it('returns undefined for session_id and agent_aid when they were not set', async () => {
    // Explicitly omit optional fields
    const session: ChatSession = {
      chat_jid: 'jid:noopt@s.whatsapp.net',
      channel_type: 'discord',
      last_timestamp: new Date(1_000),
      last_agent_timestamp: new Date(2_000),
    };
    await store.upsert(session);

    const retrieved = await store.get('jid:noopt@s.whatsapp.net');
    expect(retrieved.session_id).toBeUndefined();
    expect(retrieved.agent_aid).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Get throws NotFoundError for missing JID
// ---------------------------------------------------------------------------

describe('get — not found', () => {
  it('throws NotFoundError when the session does not exist', async () => {
    await expect(store.get('jid:does-not-exist')).rejects.toThrow(NotFoundError);
  });

  it('includes the resource and ID in the error', async () => {
    let caught: NotFoundError | undefined;
    try {
      await store.get('jid:missing@s.whatsapp.net');
    } catch (e) {
      if (e instanceof NotFoundError) caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught!.resource).toBe('session');
    expect(caught!.id).toBe('jid:missing@s.whatsapp.net');
    expect(caught!.message).toBe('session not found: jid:missing@s.whatsapp.net');
  });
});

// ---------------------------------------------------------------------------
// Upsert creates a new session
// ---------------------------------------------------------------------------

describe('upsert — create', () => {
  it('inserts a new session when it does not exist', async () => {
    const session = makeSession({ chat_jid: 'jid:new@s.whatsapp.net' });
    await store.upsert(session);

    const retrieved = await store.get('jid:new@s.whatsapp.net');
    expect(retrieved.chat_jid).toBe('jid:new@s.whatsapp.net');
  });

  it('returns void (no error) on successful insert', async () => {
    const session = makeSession({ chat_jid: 'jid:void@s.whatsapp.net' });
    await expect(store.upsert(session)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Upsert updates an existing session (ON CONFLICT)
// ---------------------------------------------------------------------------

describe('upsert — update on conflict', () => {
  it('updates all five updatable columns when a session already exists', async () => {
    // Initial insert
    const initial = makeSession({
      chat_jid: 'jid:conflict@s.whatsapp.net',
      channel_type: 'discord',
      last_timestamp: new Date(1_000),
      last_agent_timestamp: new Date(2_000),
      session_id: 'sess-old',
      agent_aid: 'aid-old',
    });
    await store.upsert(initial);

    // Conflict update with new values
    const updated: ChatSession = {
      chat_jid: 'jid:conflict@s.whatsapp.net',
      channel_type: 'whatsapp',
      last_timestamp: new Date(5_000),
      last_agent_timestamp: new Date(6_000),
      session_id: 'sess-new',
      agent_aid: 'aid-new',
    };
    await store.upsert(updated);

    const retrieved = await store.get('jid:conflict@s.whatsapp.net');
    expect(retrieved.channel_type).toBe('whatsapp');
    expect(retrieved.last_timestamp.getTime()).toBe(5_000);
    expect(retrieved.last_agent_timestamp.getTime()).toBe(6_000);
    expect(retrieved.session_id).toBe('sess-new');
    expect(retrieved.agent_aid).toBe('aid-new');
  });

  it('does not duplicate the row — only one row exists after upsert', async () => {
    const session = makeSession({ chat_jid: 'jid:dup@s.whatsapp.net' });
    await store.upsert(session);
    await store.upsert({ ...session, channel_type: 'whatsapp' });

    const all = await store.listAll();
    const matching = all.filter((s) => s.chat_jid === 'jid:dup@s.whatsapp.net');
    expect(matching).toHaveLength(1);
  });

  it('can clear optional fields by passing empty (undefined) values', async () => {
    // Insert with optional fields set
    const initial: ChatSession = {
      chat_jid: 'jid:clearopt@s.whatsapp.net',
      channel_type: 'discord',
      last_timestamp: new Date(1_000),
      last_agent_timestamp: new Date(2_000),
      session_id: 'sess-123',
      agent_aid: 'aid-456',
    };
    await store.upsert(initial);

    // Upsert without optional fields
    const cleared: ChatSession = {
      chat_jid: 'jid:clearopt@s.whatsapp.net',
      channel_type: 'discord',
      last_timestamp: new Date(3_000),
      last_agent_timestamp: new Date(4_000),
    };
    await store.upsert(cleared);

    const retrieved = await store.get('jid:clearopt@s.whatsapp.net');
    expect(retrieved.session_id).toBeUndefined();
    expect(retrieved.agent_aid).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Delete removes session
// ---------------------------------------------------------------------------

describe('delete', () => {
  it('removes the session for the given JID', async () => {
    const session = makeSession({ chat_jid: 'jid:del@s.whatsapp.net' });
    await store.upsert(session);

    await store.delete('jid:del@s.whatsapp.net');

    await expect(store.get('jid:del@s.whatsapp.net')).rejects.toThrow(NotFoundError);
  });

  it('does not affect other sessions', async () => {
    await store.upsert(makeSession({ chat_jid: 'jid:del-target@s.whatsapp.net' }));
    await store.upsert(makeSession({ chat_jid: 'jid:keep@s.whatsapp.net' }));

    await store.delete('jid:del-target@s.whatsapp.net');

    // Deleted session is gone
    await expect(store.get('jid:del-target@s.whatsapp.net')).rejects.toThrow(NotFoundError);
    // Other session still exists
    const kept = await store.get('jid:keep@s.whatsapp.net');
    expect(kept.chat_jid).toBe('jid:keep@s.whatsapp.net');
  });

  it('does not throw when deleting a non-existent JID', async () => {
    await expect(store.delete('jid:ghost@s.whatsapp.net')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ListAll returns all sessions
// ---------------------------------------------------------------------------

describe('listAll', () => {
  it('returns an empty array when no sessions exist', async () => {
    const all = await store.listAll();
    expect(all).toEqual([]);
  });

  it('returns all inserted sessions', async () => {
    await store.upsert(makeSession({ chat_jid: 'jid:a@s.whatsapp.net' }));
    await store.upsert(makeSession({ chat_jid: 'jid:b@s.whatsapp.net' }));
    await store.upsert(makeSession({ chat_jid: 'jid:c@s.whatsapp.net' }));

    const all = await store.listAll();
    expect(all).toHaveLength(3);
    const jids = all.map((s) => s.chat_jid).sort();
    expect(jids).toEqual([
      'jid:a@s.whatsapp.net',
      'jid:b@s.whatsapp.net',
      'jid:c@s.whatsapp.net',
    ]);
  });

  it('reflects latest values after upsert', async () => {
    await store.upsert(
      makeSession({ chat_jid: 'jid:updated@s.whatsapp.net', channel_type: 'discord' }),
    );
    await store.upsert(
      makeSession({ chat_jid: 'jid:updated@s.whatsapp.net', channel_type: 'whatsapp' }),
    );

    const all = await store.listAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.channel_type).toBe('whatsapp');
  });

  it('does not return deleted sessions', async () => {
    await store.upsert(makeSession({ chat_jid: 'jid:live@s.whatsapp.net' }));
    await store.upsert(makeSession({ chat_jid: 'jid:gone@s.whatsapp.net' }));

    await store.delete('jid:gone@s.whatsapp.net');

    const all = await store.listAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.chat_jid).toBe('jid:live@s.whatsapp.net');
  });
});
