/**
 * memory_list tool handler — lists memory entries for a team,
 * optionally filtered by type.
 */

import { z } from 'zod';
import type { IMemoryStore } from '../../domain/interfaces.js';
import type { MemoryEntry } from '../../domain/types.js';

export const MemoryListInputSchema = z.object({
  type: z.string().optional(),
});

export interface MemoryListDeps {
  memoryStore: IMemoryStore;
}

export async function memoryList(
  input: z.infer<typeof MemoryListInputSchema>,
  teamName: string,
  deps: MemoryListDeps,
): Promise<MemoryEntry[]> {
  return deps.memoryStore.list(teamName, input.type);
}
