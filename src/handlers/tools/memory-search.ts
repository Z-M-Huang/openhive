/**
 * memory_search tool handler — searches memory entries by query string.
 *
 * Supports keyword search (FTS5) and optionally hybrid vector search
 * when an embedding function is provided.
 */

import { z } from 'zod';
import type { IMemoryStore } from '../../domain/interfaces.js';
import type { MemorySearchResult } from '../../domain/types.js';

export const MemorySearchInputSchema = z.object({
  query: z.string().min(1),
  max_results: z.number().int().positive().optional().default(5),
});

export interface MemorySearchDeps {
  memoryStore: IMemoryStore;
  embeddingFn?: (text: string) => Promise<number[]>;
}

export async function memorySearch(
  input: z.infer<typeof MemorySearchInputSchema>,
  teamName: string,
  deps: MemorySearchDeps,
): Promise<MemorySearchResult[]> {
  return deps.memoryStore.search(teamName, input.query, input.max_results, deps.embeddingFn);
}
