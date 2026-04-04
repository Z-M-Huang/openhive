/**
 * Memory Search — UAT tests.
 *
 * Covers: UAT-4 (keyword search & scoring), UAT-5 (hybrid search)
 *
 * Uses a real in-memory SQLite database with FTS5 to validate the
 * search pipeline end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { createTables } from '../database.js';
import { MemoryStore } from './memory-store.js';
import { searchMemory } from './memory-search.js';
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

// ── UAT-4: Keyword Search & Scoring ─────────────────────────────────────

describe('MemorySearch — UAT-4: Keyword Search', () => {
  it('keyword search returns entries matching the query term', async () => {
    store.save('team-a', 'deployment', 'We use kubernetes for deployment orchestration', 'context');
    store.save('team-a', 'testing', 'Unit tests run with vitest framework', 'context');

    const results = await searchMemory(raw, 'team-a', 'kubernetes', 5);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].key).toBe('deployment');
    expect(results[0].source).toBe('keyword');
  });

  it('results include a numeric score field', async () => {
    store.save('team-a', 'focused', 'kubernetes kubernetes kubernetes is our platform', 'context');
    store.save('team-a', 'mention', 'We sometimes talk about kubernetes in meetings', 'context');

    const results = await searchMemory(raw, 'team-a', 'kubernetes', 5);

    expect(results.length).toBe(2);
    // Both entries should have a defined numeric score
    for (const r of results) {
      expect(typeof r.score).toBe('number');
      expect(r.score).toBeGreaterThanOrEqual(0);
    }
  });

  it('superseded entries are excluded from keyword search results', async () => {
    store.save('team-a', 'evolving', 'old approach uses docker swarm', 'context');
    store.save('team-a', 'evolving', 'new approach uses kubernetes', 'context', 'updated');

    const results = await searchMemory(raw, 'team-a', 'docker swarm', 5);

    // Only active versions should appear
    for (const r of results) {
      expect(r.is_active).toBe(true);
    }
  });

  it('keyword search is scoped to the requesting teamId', async () => {
    store.save('team-a', 'secret-a', 'confidential data alpha', 'context');
    store.save('team-b', 'secret-b', 'confidential data bravo', 'context');

    const results = await searchMemory(raw, 'team-a', 'confidential', 5);

    expect(results.length).toBe(1);
    expect(results[0].key).toBe('secret-a');
  });

  it('keyword search returns empty array when no entries match', async () => {
    store.save('team-a', 'k1', 'hello world', 'context');

    const results = await searchMemory(raw, 'team-a', 'xyznonexistent', 5);
    expect(results).toEqual([]);
  });

  it('keyword search supports multi-word queries', async () => {
    store.save('team-a', 'doc', 'The database migration strategy involves careful planning', 'context');

    const results = await searchMemory(raw, 'team-a', 'database migration', 5);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].key).toBe('doc');
  });
});

// ── UAT-5: Hybrid Search ────────────────────────────────────────────────

describe('MemorySearch — UAT-5: Hybrid Search', () => {
  it('empty query returns empty array', async () => {
    store.save('team-a', 'k1', 'some content', 'context');

    const results = await searchMemory(raw, 'team-a', '', 5);
    expect(results).toEqual([]);
  });

  it('query with only FTS5 special characters returns empty array', async () => {
    store.save('team-a', 'k1', 'some content', 'context');

    const results = await searchMemory(raw, 'team-a', '*"()+', 5);
    expect(results).toEqual([]);
  });

  it('temporal decay does not penalize identity type entries', async () => {
    // Create entries with old timestamps via direct SQL. We need a third
    // "anchor" entry with a better keyword match so that normalizeScores
    // produces non-zero values for the two entries we care about.
    const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000).toISOString();

    // Helper to insert a memory + chunk + FTS row with a given date
    function insertDirect(key: string, content: string, type: string, date: string): void {
      const r = raw.prepare(
        `INSERT INTO memories (team_name, key, content, type, is_active, created_at, updated_at)
         VALUES ('team-a', ?, ?, ?, 1, ?, ?)`,
      ).run(key, content, type, date, date);
      const memId = Number(r.lastInsertRowid);
      const cr = raw.prepare(
        `INSERT INTO memory_chunks (memory_id, team_name, chunk_content, chunk_index, content_hash, created_at)
         VALUES (?, 'team-a', ?, 0, ?, ?)`,
      ).run(memId, content, `hash-${key}`, date);
      const chunkId = Number(cr.lastInsertRowid);
      raw.prepare('INSERT INTO memory_chunks_fts(rowid, chunk_content) VALUES(?, ?)').run(chunkId, content);
    }

    // Anchor entry — recent, strong match, creates score spread
    insertDirect('anchor', 'performance performance performance strong anchor', 'context', new Date().toISOString());
    // Old context entry — should be decayed
    insertDirect('old-ctx', 'performance optimization technique', 'context', sixtyDaysAgo);
    // Old identity entry — should NOT be decayed
    insertDirect('old-id', 'performance optimization identity', 'identity', sixtyDaysAgo);

    const results = await searchMemory(raw, 'team-a', 'performance optimization', 10);

    const identityResult = results.find((r) => r.key === 'old-id');
    const contextResult = results.find((r) => r.key === 'old-ctx');
    expect(identityResult).toBeDefined();
    expect(contextResult).toBeDefined();
    // Identity is exempt from temporal decay, so it should score >= context
    expect(identityResult!.score).toBeGreaterThanOrEqual(contextResult!.score);
  });

  it('respects the top-K limit parameter', async () => {
    for (let i = 0; i < 10; i++) {
      store.save('team-a', `entry${String(i)}`, `unique searchterm alpha content number ${String(i)}`, 'context');
    }

    const results = await searchMemory(raw, 'team-a', 'searchterm alpha', 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('returns empty array when store is empty', async () => {
    const results = await searchMemory(raw, 'team-a', 'anything', 5);
    expect(results).toEqual([]);
  });

  it('hybrid search is scoped to the requesting teamId', async () => {
    store.save('team-a', 'ka', 'hybrid search content alpha', 'context');
    store.save('team-b', 'kb', 'hybrid search content bravo', 'context');

    const results = await searchMemory(raw, 'team-a', 'hybrid search content', 10);

    for (const r of results) {
      expect(r.key).toBe('ka');
    }
  });
});
