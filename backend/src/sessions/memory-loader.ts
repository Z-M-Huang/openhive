/**
 * Memory loader — reads MEMORY.md and builds a prompt section.
 *
 * Only MEMORY.md is auto-injected. No fallbacks.
 * Other memory files (context.md, decisions.md, etc.) are available
 * via Read tool on demand — they are not injected into the prompt.
 *
 * Uses MemoryStore for path-validated reads (no raw readFileSync).
 */

import type { IMemoryStore } from '../domain/interfaces.js';

const MEMORY_FILE = 'MEMORY.md';

/**
 * Build the memory section for injection into systemPrompt.
 *
 * @param memoryStore  MemoryStore with baseDir pointing to .run/teams/
 * @param teamName     Team slug
 * @returns            Formatted memory section string, or empty string if no MEMORY.md
 */
export function buildMemorySection(memoryStore: IMemoryStore, teamName: string): string {
  try {
    const content = memoryStore.readFile(teamName, MEMORY_FILE);
    const trimmed = content?.trim();
    if (!trimmed) return '';
    return '--- Team Memory ---\n' + trimmed;
  } catch {
    return ''; // Corrupt file — skip, don't crash
  }
}
