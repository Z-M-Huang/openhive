/**
 * memory_save tool handler — persists a memory entry for a team.
 *
 * Supports superseding an existing key (soft-delete + new entry).
 */

import { z } from 'zod';
import type { IMemoryStore } from '../../domain/interfaces.js';
import type { MemoryEntry } from '../../domain/types.js';
import { errorMessage } from '../../domain/errors.js';

export const MemorySaveInputSchema = z.object({
  key: z.string().min(1),
  content: z.string().min(1),
  type: z.string().optional().default('context'),
  supersede_reason: z.string().optional(),
});

export interface MemorySaveDeps {
  memoryStore: IMemoryStore;
  log: (msg: string, meta?: Record<string, unknown>) => void;
}

export async function memorySave(
  input: z.infer<typeof MemorySaveInputSchema>,
  teamName: string,
  deps: MemorySaveDeps,
): Promise<{ success: boolean; entry?: MemoryEntry; error?: string }> {
  try {
    const entry = deps.memoryStore.save(teamName, input.key, input.content, input.type, input.supersede_reason);
    deps.log('memory_save', { team: teamName, key: input.key, type: input.type });
    return { success: true, entry };
  } catch (err) {
    return { success: false, error: errorMessage(err) };
  }
}
