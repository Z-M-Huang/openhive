/**
 * Memory loader — queries IMemoryStore for injectable entries
 * and builds a structured prompt section grouped by type.
 *
 * Output format:
 * --- Memory ---
 * [IDENTITY]
 *   [key1]: content1
 *   [key2]: content2
 *
 * [LESSON]
 *   [key3]: content3
 * ...
 */

import type { IMemoryStore } from '../domain/interfaces.js';
import type { MemoryEntry } from '../domain/types.js';

/** Type display order matching getInjectable's priority ordering. */
const TYPE_ORDER: readonly string[] = ['identity', 'lesson', 'decision', 'context'];

/**
 * Build the memory section for injection into systemPrompt.
 *
 * @param memoryStore  SQL-backed IMemoryStore (or undefined if not wired yet)
 * @param teamName     Team slug
 * @returns            Formatted memory section string, or empty string
 */
export function buildMemorySection(memoryStore: IMemoryStore | undefined, teamName: string): string {
  if (!memoryStore) return '';

  const entries: MemoryEntry[] = memoryStore.getInjectable(teamName, 50);

  if (entries.length === 0) return '';

  if (entries.length >= 40) {
    console.warn(`Warning: Team ${teamName} has ${entries.length} injected memories (80% of 50 cap)`);
  }

  // Group entries by type
  const groups = new Map<string, MemoryEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.type);
    if (group) {
      group.push(entry);
    } else {
      groups.set(entry.type, [entry]);
    }
  }

  // Build output following the canonical type order
  let output = '--- Memory ---';

  for (const type of TYPE_ORDER) {
    const group = groups.get(type);
    if (!group) continue;

    output += `\n[${type.toUpperCase()}]`;
    for (const entry of group) {
      output += `\n  [${entry.key}]: ${entry.content}`;
    }
    output += '\n';
  }

  return output;
}
