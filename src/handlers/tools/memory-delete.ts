/**
 * memory_delete tool handler — soft-deletes a memory entry by key.
 */

import { z } from 'zod';
import type { IMemoryStore } from '../../domain/interfaces.js';

export const MemoryDeleteInputSchema = z.object({
  key: z.string().min(1),
});

export interface MemoryDeleteDeps {
  memoryStore: IMemoryStore;
}

export async function memoryDelete(
  input: z.infer<typeof MemoryDeleteInputSchema>,
  teamName: string,
  deps: MemoryDeleteDeps,
): Promise<{ success: boolean; deleted: boolean }> {
  const deleted = deps.memoryStore.delete(teamName, input.key);
  return { success: true, deleted };
}
