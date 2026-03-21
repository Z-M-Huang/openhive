/**
 * Memory tool handlers: save_memory, recall_memory.
 *
 * @module mcp/tools/handlers-memory
 */

import { SaveMemorySchema, RecallMemorySchema } from './schemas.js';
import type { ToolContext, ToolHandler } from './types.js';

export function createMemoryHandlers(ctx: ToolContext): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  handlers.set('save_memory', async (args, agentAid, teamSlug) => {
    const parsed = SaveMemorySchema.parse(args);

    const createdAt = Date.now();
    const entry = {
      id: 0,
      content: parsed.content,
      memory_type: parsed.memory_type,
      created_at: createdAt,
    };

    // Drain pending writes first (drain-on-write pattern)
    if (ctx.pendingMemoryWrites && ctx.pendingMemoryWrites.length > 0) {
      const pending = [...ctx.pendingMemoryWrites];
      ctx.pendingMemoryWrites.length = 0;
      for (const pw of pending) {
        try {
          await ctx.memoryStore.save(pw);
        } catch {
          if (ctx.pendingMemoryWrites.length < 100) {
            ctx.pendingMemoryWrites.push(pw);
          }
        }
      }
    }

    // AC-L6-06: DUAL-WRITE - file FIRST (source of truth), then SQLite index
    if (ctx.memoryFileWriter) {
      await ctx.memoryFileWriter(agentAid, teamSlug, entry);
    }

    // AC-L6-07: Index in SQLite for fast search/recall
    let memoryId = 0;
    try {
      memoryId = await ctx.memoryStore.save({
        id: 0,
        agent_aid: agentAid,
        team_slug: teamSlug,
        content: parsed.content,
        memory_type: parsed.memory_type,
        created_at: createdAt,
        deleted_at: null,
      });
    } catch (sqliteErr) {
      if (ctx.pendingMemoryWrites) {
        if (ctx.pendingMemoryWrites.length >= 100) {
          ctx.pendingMemoryWrites.shift();
        }
        ctx.pendingMemoryWrites.push({
          id: 0,
          agent_aid: agentAid,
          team_slug: teamSlug,
          content: parsed.content,
          memory_type: parsed.memory_type,
          created_at: createdAt,
          deleted_at: null,
          retries: 0,
          lastError: sqliteErr instanceof Error ? sqliteErr.message : String(sqliteErr),
        });
        ctx.logger.warn('SQLite index write failed, queued for retry', {
          agent_aid: agentAid,
          queue_size: ctx.pendingMemoryWrites.length,
          error: sqliteErr instanceof Error ? sqliteErr.message : String(sqliteErr),
        });
      } else {
        throw sqliteErr;
      }
    }

    // Auto-embed for vector search (skip silently on failure)
    if (memoryId > 0 && ctx.embeddingService) {
      try {
        const embedding = await ctx.embeddingService.embed(parsed.content);
        await ctx.memoryStore.saveChunks(memoryId, [{
          content: parsed.content,
          embedding,
          embeddingModel: ctx.embeddingService.modelId,
        }]);
      } catch {
        // Embedding failure is non-fatal — search degrades to BM25-only
      }
    }

    return { memory_id: memoryId, status: 'saved' };
  });

  handlers.set('recall_memory', async (args, agentAid) => {
    const parsed = RecallMemorySchema.parse(args);

    let memories: import('../../domain/domain.js').MemoryEntry[];
    const limit = parsed.limit ?? 10;

    try {
      let queryEmbedding: Float32Array | undefined;
      if (ctx.embeddingService) {
        try {
          queryEmbedding = await ctx.embeddingService.embed(parsed.query);
        } catch { /* embedding failure — proceed with BM25 only */ }
      }

      memories = await ctx.memoryStore.searchHybrid(
        parsed.query,
        agentAid,
        queryEmbedding,
        limit,
      );
    } catch {
      memories = await ctx.memoryStore.search({
        agentAid,
        query: parsed.query,
        limit,
        since: parsed.since ? new Date(parsed.since) : undefined,
      });
    }

    return {
      memories: memories.map((m) => ({
        id: m.id,
        content: m.content,
        memory_type: m.memory_type,
        created_at: m.created_at,
      })),
    };
  });

  return handlers;
}
