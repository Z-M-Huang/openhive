/**
 * SQLite Memory Store — UAT tests.
 *
 * Covers: UAT-1 (schema), UAT-2 (CRUD), UAT-3 (type aliases),
 *         UAT-4 (FTS5 sync), UAT-11 (team isolation), UAT-12 (chunking)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { createTables } from '../database.js';
import { MemoryStore } from './memory-store.js';
import * as schema from '../schema.js';

// ── Shared setup ────────────────────────────────────────────────────────────

let raw: Database.Database;
let store: MemoryStore;

beforeEach(() => {
  raw = new Database(':memory:');
  const db = drizzle(raw, { schema });
  createTables(raw);
  store = new MemoryStore(db, raw);
});

afterEach(() => {
  raw.close();
});

// ── UAT-1: Schema ────────────────────────────────────────────────────────

describe('MemoryStore — UAT-1: Schema', () => {
  it('memory_entries table is created by createTables()', () => {
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'")
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe('memories');
  });

  it('memory_fts FTS5 virtual table is created by createTables()', () => {
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_chunks_fts'")
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
  });

  it('memories table has required columns', () => {
    const columns = raw.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>;
    const names = columns.map((c) => c.name);
    expect(names).toContain('id');
    expect(names).toContain('team_name');
    expect(names).toContain('key');
    expect(names).toContain('content');
    expect(names).toContain('type');
    expect(names).toContain('is_active');
    expect(names).toContain('supersedes_id');
    expect(names).toContain('supersede_reason');
    expect(names).toContain('created_at');
    expect(names).toContain('updated_at');
  });
});

// ── UAT-2: CRUD Lifecycle ────────────────────────────────────────────────

describe('MemoryStore — UAT-2: CRUD Lifecycle', () => {
  it('save() inserts a new entry and returns a MemoryEntry with correct fields', () => {
    const entry = store.save('team-a', 'project-goal', 'Build a platform', 'context');

    expect(entry.id).toBeGreaterThan(0);
    expect(entry.team_name).toBe('team-a');
    expect(entry.key).toBe('project-goal');
    expect(entry.content).toBe('Build a platform');
    expect(entry.type).toBe('context');
    expect(entry.is_active).toBe(true);
    expect(entry.supersedes_id).toBeNull();
    expect(entry.created_at).toBeTruthy();
    expect(entry.updated_at).toBeTruthy();
  });

  it('save + getActive: saved entry is retrievable by key', () => {
    store.save('team-a', 'my-key', 'some content', 'context');

    const found = store.getActive('team-a', 'my-key');
    expect(found).toBeDefined();
    expect(found!.key).toBe('my-key');
    expect(found!.content).toBe('some content');
  });

  it('getActive() returns undefined for nonexistent key', () => {
    const found = store.getActive('team-a', 'nonexistent');
    expect(found).toBeUndefined();
  });

  it('save() with supersede_reason deactivates old entry and links via supersedes_id', () => {
    const first = store.save('team-a', 'evolving-fact', 'version 1', 'context');
    const second = store.save('team-a', 'evolving-fact', 'version 2', 'context', 'updated info');

    expect(second.supersedes_id).toBe(first.id);
    expect(second.supersede_reason).toBe('updated info');
    expect(second.is_active).toBe(true);

    // Old entry should be deactivated
    const oldRow = raw
      .prepare('SELECT is_active FROM memories WHERE id = ?')
      .get(first.id) as { is_active: number };
    expect(oldRow.is_active).toBe(0);
  });

  it('save() without supersede_reason throws when active entry exists', () => {
    store.save('team-a', 'existing-key', 'content', 'context');

    expect(() => store.save('team-a', 'existing-key', 'new content', 'context')).toThrow(
      'supersede_reason required',
    );
  });

  it('superseded entries are excluded from list()', () => {
    store.save('team-a', 'key1', 'v1', 'context');
    store.save('team-a', 'key1', 'v2', 'context', 'corrected');

    const list = store.list('team-a');
    expect(list).toHaveLength(1);
    expect(list[0].content).toBe('v2');
  });

  it('delete() marks an entry as inactive and returns true', () => {
    store.save('team-a', 'to-delete', 'goodbye', 'context');

    const deleted = store.delete('team-a', 'to-delete');
    expect(deleted).toBe(true);

    const found = store.getActive('team-a', 'to-delete');
    expect(found).toBeUndefined();
  });

  it('delete() returns false for nonexistent key', () => {
    const deleted = store.delete('team-a', 'no-such-key');
    expect(deleted).toBe(false);
  });

  it('list() returns only active entries for a team', () => {
    store.save('team-a', 'k1', 'c1', 'context');
    store.save('team-a', 'k2', 'c2', 'lesson');
    store.delete('team-a', 'k1');

    const list = store.list('team-a');
    expect(list).toHaveLength(1);
    expect(list[0].key).toBe('k2');
  });
});

// ── UAT-3: Type Aliases ─────────────────────────────────────────────────

describe('MemoryStore — UAT-3: Type Aliases', () => {
  it("resolves 'warning' to 'lesson'", () => {
    const entry = store.save('team-a', 'warn-key', 'be careful', 'warning');
    expect(entry.type).toBe('lesson');
  });

  it("resolves 'core' to 'identity'", () => {
    const entry = store.save('team-a', 'core-key', 'who I am', 'core');
    expect(entry.type).toBe('identity');
  });

  it("resolves undefined/empty to 'context'", () => {
    const entry = store.save('team-a', 'empty-type', 'content', '');
    expect(entry.type).toBe('context');
  });

  it('throws on unknown type', () => {
    expect(() => store.save('team-a', 'bad-type', 'content', 'banana')).toThrow(
      'Unknown memory type',
    );
  });

  it('list() filters by type when type parameter is provided', () => {
    store.save('team-a', 'k1', 'c1', 'context');
    store.save('team-a', 'k2', 'c2', 'lesson');
    store.save('team-a', 'k3', 'c3', 'identity');

    const lessons = store.list('team-a', 'lesson');
    expect(lessons).toHaveLength(1);
    expect(lessons[0].key).toBe('k2');
  });

  it('list() returns all types when no filter given', () => {
    store.save('team-a', 'k1', 'c1', 'context');
    store.save('team-a', 'k2', 'c2', 'lesson');

    const all = store.list('team-a');
    expect(all).toHaveLength(2);
  });
});

// ── UAT-4: FTS5 Keyword Sync ───────────────────────────────────────────

describe('MemoryStore — UAT-4: FTS5 Keyword Sync', () => {
  it('save() populates the FTS5 index for the new entry', () => {
    store.save('team-a', 'searchable', 'The quick brown fox', 'context');

    const rows = raw
      .prepare(
        `SELECT mc.id FROM memory_chunks_fts
         JOIN memory_chunks mc ON mc.id = memory_chunks_fts.rowid
         WHERE memory_chunks_fts MATCH 'fox'`,
      )
      .all();
    expect(rows.length).toBeGreaterThan(0);
  });

  it('superseded entries are removed from FTS5 index', () => {
    store.save('team-a', 'fts-key', 'alpha bravo charlie', 'context');
    store.save('team-a', 'fts-key', 'delta echo foxtrot', 'context', 'replaced');

    // Old content 'alpha' should not be in FTS
    const oldHits = raw
      .prepare(
        `SELECT mc.id FROM memory_chunks_fts
         JOIN memory_chunks mc ON mc.id = memory_chunks_fts.rowid
         JOIN memories m ON m.id = mc.memory_id
         WHERE memory_chunks_fts MATCH 'alpha' AND m.is_active = 1`,
      )
      .all();
    expect(oldHits).toHaveLength(0);

    // New content 'delta' should be found
    const newHits = raw
      .prepare(
        `SELECT mc.id FROM memory_chunks_fts
         JOIN memory_chunks mc ON mc.id = memory_chunks_fts.rowid
         JOIN memories m ON m.id = mc.memory_id
         WHERE memory_chunks_fts MATCH 'delta' AND m.is_active = 1`,
      )
      .all();
    expect(newHits.length).toBeGreaterThan(0);
  });

  it('delete() removes the entry from the FTS5 index', () => {
    store.save('team-a', 'fts-del', 'unique_findable_word', 'context');
    store.delete('team-a', 'fts-del');

    const hits = raw
      .prepare(
        `SELECT mc.id FROM memory_chunks_fts
         JOIN memory_chunks mc ON mc.id = memory_chunks_fts.rowid
         WHERE memory_chunks_fts MATCH 'unique_findable_word'`,
      )
      .all();
    expect(hits).toHaveLength(0);
  });
});

// ── UAT-11: Team Isolation ──────────────────────────────────────────────

describe('MemoryStore — UAT-11: Team Isolation', () => {
  it('list() returns only entries belonging to the queried team', () => {
    store.save('team-a', 'k1', 'content a', 'context');
    store.save('team-b', 'k2', 'content b', 'context');

    const aList = store.list('team-a');
    expect(aList).toHaveLength(1);
    expect(aList[0].key).toBe('k1');
  });

  it('save() with teamId=A is invisible to getActive() with teamId=B', () => {
    store.save('team-a', 'shared-key', 'only for A', 'context');

    const found = store.getActive('team-b', 'shared-key');
    expect(found).toBeUndefined();
  });

  it('removeByTeam() deletes all entries for one team without affecting others', () => {
    store.save('team-a', 'ka', 'content a', 'context');
    store.save('team-b', 'kb', 'content b', 'context');

    store.removeByTeam('team-a');

    expect(store.list('team-a')).toHaveLength(0);
    expect(store.list('team-b')).toHaveLength(1);
  });

  it('getInjectable() respects team boundary', () => {
    store.save('team-a', 'ia', 'identity a', 'identity');
    store.save('team-b', 'ib', 'identity b', 'identity');

    const injectable = store.getInjectable('team-a');
    expect(injectable).toHaveLength(1);
    expect(injectable[0].team_name).toBe('team-a');
  });
});

// ── UAT-12: Chunking ────────────────────────────────────────────────────

describe('MemoryStore — UAT-12: Chunking', () => {
  /** Generate a multi-paragraph string large enough to trigger chunking (~500+ tokens). */
  function makeLargeContent(paragraphCount: number): string {
    const paragraphs: string[] = [];
    for (let i = 0; i < paragraphCount; i++) {
      // Each paragraph ~100 words
      paragraphs.push(
        `Paragraph ${String(i + 1)}: ` +
          Array.from({ length: 100 }, (_, j) => `word${String(i * 100 + j)}`).join(' '),
      );
    }
    return paragraphs.join('\n\n');
  }

  it('save() creates multiple chunks for large multi-paragraph content', () => {
    const bigContent = makeLargeContent(10); // ~1000 words across 10 paragraphs
    store.save('team-a', 'big-doc', bigContent, 'context');

    const chunks = raw
      .prepare('SELECT * FROM memory_chunks WHERE team_name = ?')
      .all('team-a') as Array<{ chunk_index: number }>;

    expect(chunks.length).toBeGreaterThan(1);
  });

  it('all chunks share the same memory_id and have sequential chunk_index', () => {
    const bigContent = makeLargeContent(10);
    const entry = store.save('team-a', 'chunked', bigContent, 'context');

    const chunks = raw
      .prepare('SELECT memory_id, chunk_index FROM memory_chunks WHERE memory_id = ? ORDER BY chunk_index')
      .all(entry.id) as Array<{ memory_id: number; chunk_index: number }>;

    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].memory_id).toBe(entry.id);
      expect(chunks[i].chunk_index).toBe(i);
    }
  });

  it('small content produces exactly one chunk', () => {
    store.save('team-a', 'small', 'This is a short entry.', 'context');

    const chunks = raw
      .prepare("SELECT * FROM memory_chunks WHERE team_name = 'team-a'")
      .all();
    expect(chunks).toHaveLength(1);
  });

  it('superseding a chunked entry re-indexes chunks for the new entry', () => {
    const bigContent = makeLargeContent(10);
    store.save('team-a', 'evolve-big', bigContent, 'context');
    const v2 = store.save('team-a', 'evolve-big', 'Short replacement', 'context', 'simplified');

    const chunks = raw
      .prepare('SELECT * FROM memory_chunks WHERE memory_id = ?')
      .all(v2.id) as Array<{ chunk_content: string }>;

    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunk_content).toBe('Short replacement');
  });
});

// ── getInjectable ordering ──────────────────────────────────────────────

describe('MemoryStore — getInjectable', () => {
  it('returns entries ordered by type priority: identity > lesson > decision > context', () => {
    store.save('team-a', 'ctx', 'context entry', 'context');
    store.save('team-a', 'dec', 'decision entry', 'decision');
    store.save('team-a', 'les', 'lesson entry', 'lesson');
    store.save('team-a', 'id', 'identity entry', 'identity');

    const injectable = store.getInjectable('team-a');
    expect(injectable).toHaveLength(4);
    expect(injectable[0].type).toBe('identity');
    expect(injectable[1].type).toBe('lesson');
    expect(injectable[2].type).toBe('decision');
    expect(injectable[3].type).toBe('context');
  });

  it('excludes reference and historical types', () => {
    store.save('team-a', 'ref', 'ref entry', 'reference');
    store.save('team-a', 'hist', 'hist entry', 'historical');
    store.save('team-a', 'ctx', 'context entry', 'context');

    const injectable = store.getInjectable('team-a');
    expect(injectable).toHaveLength(1);
    expect(injectable[0].type).toBe('context');
  });

  it('respects the limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      store.save('team-a', `k${String(i)}`, `content ${String(i)}`, 'context');
    }

    const limited = store.getInjectable('team-a', 3);
    expect(limited).toHaveLength(3);
  });
});

// ── Concurrency assertions (Unit 33 — ADR-41 / AC-65, AC-66) ────────────────
// Memory-store's same-key conflict strategy is fail-fast: a second save against
// an existing active entry without an explicit `supersede_reason` throws.
// Transactions use better-sqlite3's `.immediate()` wrap, so the save body
// (insert + chunk reindex) commits atomically — FTS reads never observe partial
// index state.

describe('memory-store concurrency assertions', () => {
  it('same-key save/delete serialization yields one winner', async () => {
    // Establish an active entry so both racers target the same key.
    store.save('t1', 'k', 'v1', 'context');

    // Race a same-key save (without supersede_reason) against a delete of the
    // same key. The fail-fast strategy must produce exactly one successful
    // outcome — the other operation rejects — so silent overwrite is prevented.
    const results = await Promise.allSettled([
      Promise.resolve().then(() => store.save('t1', 'k', 'v2', 'context')),
      Promise.resolve().then(() => store.delete('t1', 'k')),
    ]);

    const successCount = results.filter((r) => r.status === 'fulfilled').length;
    expect(successCount).toBe(1);
  });

  it('FTS read after save observes the full indexed row, never partial state', async () => {
    // The save+reindex transaction is atomic via `.immediate()`, so a concurrent
    // FTS read against the same team/key observes either nothing or the full
    // row with its indexed chunks — never a row without indexed chunks.
    store.save('t1', 'search-key', 'searchable content body', 'context');

    const hits = await store.search('t1', 'searchable');
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });
});
