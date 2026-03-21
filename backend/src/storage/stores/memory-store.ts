/**
 * MemoryStore implementation.
 *
 * @module storage/stores/memory-store
 */

import { eq, and, lt, lte, gte, desc, isNull, sql } from 'drizzle-orm';
import type { Database } from '../database.js';
import * as schema from '../schema.js';
import type { MemoryStore, MemoryQuery, MemoryChunk } from '../../domain/interfaces.js';
import type { MemoryEntry } from '../../domain/domain.js';
import { rowToMemoryEntry } from './helpers.js';
import { cosineSimilarity, applyDecayForEntry, applyTemporalDecay, mmrRerank } from './memory-search.js';

export function newMemoryStore(db: Database): MemoryStore {
  return {
    async save(entry: MemoryEntry): Promise<number> {
      let insertedId = 0;
      await db.enqueueWrite(() => {
        const result = db.getDB().insert(schema.agentMemories).values({
          agent_aid: entry.agent_aid,
          team_slug: entry.team_slug,
          content: entry.content,
          memory_type: entry.memory_type,
          created_at: entry.created_at,
          deleted_at: entry.deleted_at,
        }).run();
        insertedId = Number(result.lastInsertRowid);
      });
      return insertedId;
    },

    async search(query: MemoryQuery): Promise<MemoryEntry[]> {
      const conditions = [isNull(schema.agentMemories.deleted_at)];

      if (query.agentAid) {
        conditions.push(eq(schema.agentMemories.agent_aid, query.agentAid));
      }
      if (query.teamSlug) {
        conditions.push(eq(schema.agentMemories.team_slug, query.teamSlug));
      }
      if (query.since) {
        conditions.push(gte(schema.agentMemories.created_at, query.since.getTime()));
      }
      if (query.query) {
        // LIKE-based text matching on content with escaped wildcards
        const escapedQuery = query.query.replace(/[%_]/g, '\\$&');
        conditions.push(sql`${schema.agentMemories.content} LIKE ${'%' + escapedQuery + '%'} ESCAPE '\\'`);
      }

      let q = db.getDB()
        .select()
        .from(schema.agentMemories)
        .where(and(...conditions))
        .orderBy(desc(schema.agentMemories.created_at))
        .$dynamic();

      if (query.limit) {
        q = q.limit(query.limit);
      }

      const rows = q.all();
      return rows.map(rowToMemoryEntry);
    },

    async getByAgent(agentAID: string): Promise<MemoryEntry[]> {
      const rows = db.getDB()
        .select()
        .from(schema.agentMemories)
        .where(
          and(
            eq(schema.agentMemories.agent_aid, agentAID),
            isNull(schema.agentMemories.deleted_at),
          )
        )
        .orderBy(desc(schema.agentMemories.created_at))
        .all();
      return rows.map(rowToMemoryEntry);
    },

    async deleteBefore(date: Date): Promise<number> {
      const ts = date.getTime();
      return db.enqueueWrite(() => {
        const result = db.getDB().delete(schema.agentMemories)
          .where(lt(schema.agentMemories.created_at, ts))
          .run();
        return result.changes;
      });
    },

    async softDeleteByAgent(agentAID: string): Promise<number> {
      const now = Date.now();
      return db.enqueueWrite(() => {
        const result = db.getDB().update(schema.agentMemories)
          .set({ deleted_at: now })
          .where(
            and(
              eq(schema.agentMemories.agent_aid, agentAID),
              isNull(schema.agentMemories.deleted_at),
            )
          )
          .run();
        return result.changes;
      });
    },

    async softDeleteByTeam(teamSlug: string): Promise<number> {
      const now = Date.now();
      return db.enqueueWrite(() => {
        const result = db.getDB().update(schema.agentMemories)
          .set({ deleted_at: now })
          .where(
            and(
              eq(schema.agentMemories.team_slug, teamSlug),
              isNull(schema.agentMemories.deleted_at),
            )
          )
          .run();
        return result.changes;
      });
    },

    async purgeDeleted(olderThanDays: number): Promise<number> {
      const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
      return db.enqueueWrite(() => {
        const result = db.getDB().delete(schema.agentMemories)
          .where(
            and(
              sql`${schema.agentMemories.deleted_at} IS NOT NULL`,
              lte(schema.agentMemories.deleted_at, cutoff),
            )
          )
          .run();
        return result.changes;
      });
    },

    async searchBM25(query: string, agentAid: string, limit = 10): Promise<MemoryEntry[]> {
      // Try FTS5 first, fall back to LIKE
      try {
        const rows = db.getDB().all<Record<string, unknown>>(sql`
          SELECT m.* FROM agent_memories_fts fts
          JOIN agent_memories m ON m.id = fts.rowid
          WHERE fts.content MATCH ${query}
            AND m.agent_aid = ${agentAid}
            AND m.deleted_at IS NULL
          ORDER BY rank
          LIMIT ${limit}
        `);
        return rows.map(row => rowToMemoryEntry(row as typeof schema.agentMemories.$inferSelect));
      } catch {
        // FTS5 not available — fall back to LIKE
        const escapedQuery = query.replace(/[%_]/g, '\\$&');
        const rows = db.getDB()
          .select()
          .from(schema.agentMemories)
          .where(
            and(
              eq(schema.agentMemories.agent_aid, agentAid),
              isNull(schema.agentMemories.deleted_at),
              sql`${schema.agentMemories.content} LIKE ${'%' + escapedQuery + '%'} ESCAPE '\\'`,
            )
          )
          .orderBy(desc(schema.agentMemories.created_at))
          .limit(limit)
          .all();
        return rows.map(rowToMemoryEntry);
      }
    },

    async searchHybrid(query: string, agentAid: string, queryEmbedding?: Float32Array, limit = 10): Promise<MemoryEntry[]> {
      // Step 1: BM25 candidates (top 100)
      const bm25Results = await this.searchBM25(query, agentAid, 100);

      if (!queryEmbedding || bm25Results.length === 0) {
        // No embedding available — return BM25 results with type-based decay
        return applyTemporalDecay(bm25Results).slice(0, limit);
      }

      // Step 2: Load chunks for BM25 candidates and compute cosine similarity
      const scored: Array<{ entry: MemoryEntry; score: number }> = [];
      for (const entry of bm25Results) {
        const chunks = await this.getChunks(entry.id);
        if (chunks.length === 0) {
          // No embeddings — use BM25 rank position as score
          const bm25Score = 1 - (bm25Results.indexOf(entry) / bm25Results.length);
          scored.push({ entry, score: applyDecayForEntry(entry, bm25Score) });
          continue;
        }

        // Best chunk cosine similarity
        let bestSim = 0;
        for (const chunk of chunks) {
          const sim = cosineSimilarity(queryEmbedding, chunk.embedding);
          if (sim > bestSim) bestSim = sim;
        }

        // Hybrid merge: 0.7 * vector + 0.3 * BM25
        const bm25Score = 1 - (bm25Results.indexOf(entry) / bm25Results.length);
        const hybridScore = 0.7 * bestSim + 0.3 * bm25Score;
        scored.push({ entry, score: applyDecayForEntry(entry, hybridScore) });
      }

      // Step 3: Sort by score descending
      scored.sort((a, b) => b.score - a.score);

      // Step 4: MMR reranking (lambda=0.7)
      const selected = mmrRerank(scored, queryEmbedding, limit, 0.7);

      return selected.map(s => s.entry);
    },

    async saveChunks(memoryId: number, chunks: Array<{ content: string; embedding: Float32Array; embeddingModel: string }>): Promise<void> {
      await db.enqueueWrite(() => {
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          db.getDB().run(sql`
            INSERT INTO memory_chunks (memory_id, chunk_index, content, embedding, embedding_model, created_at)
            VALUES (${memoryId}, ${i}, ${chunk.content}, ${Buffer.from(chunk.embedding.buffer)}, ${chunk.embeddingModel}, ${Date.now()})
          `);
        }
      });
    },

    async getChunks(memoryId: number): Promise<MemoryChunk[]> {
      const rows = db.getDB().all<Record<string, unknown>>(sql`
        SELECT * FROM memory_chunks WHERE memory_id = ${memoryId} ORDER BY chunk_index
      `);
      return rows.map(row => ({
        id: row.id as number,
        memory_id: row.memory_id as number,
        chunk_index: row.chunk_index as number,
        content: row.content as string,
        embedding: new Float32Array((row.embedding as Buffer).buffer),
        embedding_model: row.embedding_model as string,
        created_at: row.created_at as number,
      }));
    },

    async deleteChunks(memoryId: number): Promise<void> {
      await db.enqueueWrite(() => {
        db.getDB().run(sql`DELETE FROM memory_chunks WHERE memory_id = ${memoryId}`);
      });
    },
  };
}
