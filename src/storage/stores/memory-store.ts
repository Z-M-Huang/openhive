/**
 * Memory store — SQLite-backed implementation of IMemoryStore.
 *
 * Uses raw prepared statements for performance-critical reads and
 * transactions for atomic save/supersede operations.
 */

import { createHash } from 'node:crypto';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type Database from 'better-sqlite3';
import type { IMemoryStore } from '../../domain/interfaces.js';
import type { MemoryEntry, MemorySearchResult, MemoryType } from '../../domain/types.js';
import { MEMORY_TYPE_ALIASES } from '../../domain/types.js';
import * as schema from '../schema.js';
import { searchMemory } from './memory-search.js';

const VALID_MEMORY_TYPES: ReadonlySet<string> = new Set<string>([
  'identity', 'lesson', 'decision', 'context', 'reference', 'historical',
]);

/** Convert a raw DB row to a typed MemoryEntry. */
function rowToEntry(row: Record<string, unknown>): MemoryEntry {
  return {
    id: row.id as number,
    team_name: row.team_name as string,
    key: row.key as string,
    content: row.content as string,
    type: row.type as MemoryType,
    is_active: (row.is_active as number) === 1,
    supersedes_id: (row.supersedes_id as number | null) ?? null,
    supersede_reason: (row.supersede_reason as string | null) ?? null,
    updated_by: (row.updated_by as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export class MemoryStore implements IMemoryStore {
  private readonly raw: Database.Database;

  constructor(
    /** Drizzle DB instance — used by later units (list, search, etc.) */
    readonly db: BetterSQLite3Database<typeof schema>,
    raw: Database.Database,
  ) {
    this.raw = raw;
  }

  /** Split content into ~400-token chunks at paragraph boundaries with 80-token overlap. */
  private splitIntoChunks(content: string): Array<{ content: string; hash: string }> {
    const paragraphs = content.split(/\n\n+/);
    const tokenCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

    const MAX = 500;
    const OVERLAP = 80;

    // Single paragraph or small content → one chunk
    if (paragraphs.length <= 1 || tokenCount(content) <= MAX) {
      return [{ content, hash: createHash('sha256').update(content).digest('hex') }];
    }

    const chunks: Array<{ content: string; hash: string }> = [];
    let currentParagraphs: string[] = [];
    let currentTokens = 0;

    for (const paragraph of paragraphs) {
      const pTokens = tokenCount(paragraph);

      if (currentTokens + pTokens > MAX && currentParagraphs.length > 0) {
        // Flush the current chunk
        const chunkText = currentParagraphs.join('\n\n');
        chunks.push({
          content: chunkText,
          hash: createHash('sha256').update(chunkText).digest('hex'),
        });

        // Compute overlap: take trailing paragraphs from the current chunk
        // that cover ~80 tokens
        const overlapParagraphs: string[] = [];
        let overlapTokens = 0;
        for (let i = currentParagraphs.length - 1; i >= 0; i--) {
          const pt = tokenCount(currentParagraphs[i]);
          if (overlapTokens + pt > OVERLAP && overlapParagraphs.length > 0) break;
          overlapParagraphs.unshift(currentParagraphs[i]);
          overlapTokens += pt;
        }

        currentParagraphs = [...overlapParagraphs];
        currentTokens = overlapTokens;
      }

      currentParagraphs.push(paragraph);
      currentTokens += pTokens;
    }

    // Flush remaining paragraphs
    if (currentParagraphs.length > 0) {
      const chunkText = currentParagraphs.join('\n\n');
      chunks.push({
        content: chunkText,
        hash: createHash('sha256').update(chunkText).digest('hex'),
      });
    }

    return chunks;
  }

  /** Re-index chunks for a memory entry (called within save()'s transaction). */
  private reindexChunks(memoryId: number, teamName: string, content: string): void {
    const oldChunks = this.raw
      .prepare('SELECT id, chunk_content FROM memory_chunks WHERE memory_id = ?')
      .all(memoryId) as Array<{ id: number; chunk_content: string }>;

    const ftsDelete = this.raw.prepare(
      "INSERT INTO memory_chunks_fts(memory_chunks_fts, rowid, chunk_content) VALUES('delete', ?, ?)",
    );
    for (const chunk of oldChunks) {
      ftsDelete.run(chunk.id, chunk.chunk_content);
    }

    this.raw.prepare('DELETE FROM memory_chunks WHERE memory_id = ?').run(memoryId);
    const newChunks = this.splitIntoChunks(content);
    const now = new Date().toISOString();

    const insertChunk = this.raw.prepare(
      `INSERT INTO memory_chunks (memory_id, team_name, chunk_content, chunk_index, content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const ftsInsert = this.raw.prepare(
      'INSERT INTO memory_chunks_fts(rowid, chunk_content) VALUES(?, ?)',
    );

    for (let i = 0; i < newChunks.length; i++) {
      const result = insertChunk.run(
        memoryId, teamName, newChunks[i].content, i, newChunks[i].hash, now,
      );
      ftsInsert.run(Number(result.lastInsertRowid), newChunks[i].content);
    }
  }

  /** Resolve a user-supplied type string to a canonical MemoryType. */
  resolveTypeAlias(input: string | undefined): MemoryType {
    if (!input || input.trim() === '') return 'context';

    const normalized = input.trim().toLowerCase();
    const alias = MEMORY_TYPE_ALIASES[normalized];
    if (alias) return alias;

    if (VALID_MEMORY_TYPES.has(normalized)) return normalized as MemoryType;

    throw new Error(`Unknown memory type: ${input}`);
  }

  getActive(teamName: string, key: string): MemoryEntry | undefined {
    const row = this.raw
      .prepare('SELECT * FROM memories WHERE team_name = ? AND key = ? AND is_active = 1')
      .get(teamName, key) as Record<string, unknown> | undefined;

    if (!row) return undefined;
    return rowToEntry(row);
  }

  save(
    teamName: string,
    key: string,
    content: string,
    type: string,
    supersedeReason?: string,
    updatedBy?: string,
  ): MemoryEntry {
    const resolvedType = this.resolveTypeAlias(type);

    return this.raw.transaction(() => {
      const existing = this.getActive(teamName, key);
      const now = new Date().toISOString();

      if (existing && !supersedeReason) {
        throw new Error(`Active entry exists for key "${key}", supersede_reason required`);
      }

      let supersedesId: number | null = null;

      if (existing && supersedeReason) {
        this.raw
          .prepare('UPDATE memories SET is_active = 0, updated_at = ? WHERE id = ?')
          .run(now, existing.id);
        supersedesId = existing.id;
      }

      const result = this.raw
        .prepare(
          `INSERT INTO memories (team_name, key, content, type, is_active, supersedes_id, supersede_reason, updated_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        )
        .run(
          teamName, key, content, resolvedType, supersedesId,
          supersedeReason ?? null, updatedBy ?? null, now, now,
        );

      const newId = Number(result.lastInsertRowid);

      this.reindexChunks(newId, teamName, content);

      return {
        id: newId,
        team_name: teamName,
        key,
        content,
        type: resolvedType,
        is_active: true,
        supersedes_id: supersedesId,
        supersede_reason: supersedeReason ?? null,
        updated_by: updatedBy ?? null,
        created_at: now,
        updated_at: now,
      };
    }).immediate();
  }

  delete(teamName: string, key: string): boolean {
    const now = new Date().toISOString();

    return this.raw.transaction(() => {
      const entry = this.raw
        .prepare('SELECT id FROM memories WHERE team_name = ? AND key = ? AND is_active = 1')
        .get(teamName, key) as { id: number } | undefined;

      if (!entry) return false;

      const chunks = this.raw
        .prepare('SELECT id, chunk_content FROM memory_chunks WHERE memory_id = ?')
        .all(entry.id) as Array<{ id: number; chunk_content: string }>;

      const ftsDelete = this.raw.prepare(
        "INSERT INTO memory_chunks_fts(memory_chunks_fts, rowid, chunk_content) VALUES('delete', ?, ?)",
      );
      for (const chunk of chunks) ftsDelete.run(chunk.id, chunk.chunk_content);

      const result = this.raw
        .prepare('UPDATE memories SET is_active = 0, updated_at = ? WHERE id = ?')
        .run(now, entry.id);

      return result.changes > 0;
    }).immediate();
  }

  search(
    teamName: string,
    query: string,
    maxResults?: number,
    embeddingFn?: (text: string) => Promise<number[]>,
  ): Promise<MemorySearchResult[]> {
    return searchMemory(this.raw, teamName, query, maxResults ?? 5, embeddingFn);
  }

  list(teamName: string, type?: string): MemoryEntry[] {
    if (type) {
      const rows = this.raw
        .prepare('SELECT * FROM memories WHERE is_active = 1 AND team_name = ? AND type = ?')
        .all(teamName, type) as Array<Record<string, unknown>>;
      return rows.map(rowToEntry);
    }

    const rows = this.raw
      .prepare('SELECT * FROM memories WHERE is_active = 1 AND team_name = ?')
      .all(teamName) as Array<Record<string, unknown>>;
    return rows.map(rowToEntry);
  }

  getInjectable(teamName: string, limit: number = 50): MemoryEntry[] {
    const rows = this.raw
      .prepare(
        `SELECT * FROM memories
         WHERE is_active = 1 AND team_name = ? AND type IN ('identity','lesson','decision','context')
         ORDER BY CASE type WHEN 'identity' THEN 1 WHEN 'lesson' THEN 2 WHEN 'decision' THEN 3 WHEN 'context' THEN 4 END, updated_at DESC
         LIMIT ?`,
      )
      .all(teamName, limit) as Array<Record<string, unknown>>;
    return rows.map(rowToEntry);
  }

  removeByTeam(teamName: string): void {
    this.raw.transaction(() => {
      const chunks = this.raw
        .prepare('SELECT id, chunk_content FROM memory_chunks WHERE team_name = ?')
        .all(teamName) as Array<{ id: number; chunk_content: string }>;
      const ftsDelete = this.raw.prepare(
        "INSERT INTO memory_chunks_fts(memory_chunks_fts, rowid, chunk_content) VALUES('delete', ?, ?)",
      );
      for (const chunk of chunks) ftsDelete.run(chunk.id, chunk.chunk_content);
      this.raw.prepare('DELETE FROM memory_chunks WHERE team_name = ?').run(teamName);
      this.raw.prepare('DELETE FROM memories WHERE team_name = ?').run(teamName);
    }).immediate();
  }
}
