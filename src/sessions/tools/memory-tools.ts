/**
 * Inline memory tool builders — wraps 4 memory handlers as AI SDK inline defs.
 *
 * Returns empty `{}` when `ctx.memoryStore` is undefined.
 */

import { tool } from 'ai';
import type { ToolSet } from 'ai';
import type { OrgToolContext } from './org-tool-context.js';

import { MemorySaveInputSchema, memorySave } from '../../handlers/tools/memory-save.js';
import { MemoryDeleteInputSchema, memoryDelete } from '../../handlers/tools/memory-delete.js';
import { MemorySearchInputSchema, memorySearch } from '../../handlers/tools/memory-search.js';
import { MemoryListInputSchema, memoryList } from '../../handlers/tools/memory-list.js';

// ── Builder ─────────────────────────────────────────────────────────────────

/**
 * Build the 4 memory tools as AI SDK inline tool definitions.
 * Returns a ToolSet keyed by bare tool name.
 * Returns empty `{}` when `ctx.memoryStore` is undefined.
 */
export function buildMemoryTools(
  ctx: OrgToolContext,
): ToolSet {
  if (!ctx.memoryStore) return {};

  const store = ctx.memoryStore;
  const tools: ToolSet = {};

  // 1. memory_delete
  tools['memory_delete'] = tool({
    description: 'Soft-delete a memory entry by key',
    inputSchema: MemoryDeleteInputSchema,
    execute: async (input) =>
      memoryDelete(input, ctx.teamName, {
        memoryStore: store,
      }),
  });

  // 2. memory_list
  tools['memory_list'] = tool({
    description: 'List memory entries for this team, optionally filtered by type',
    inputSchema: MemoryListInputSchema,
    execute: async (input) =>
      memoryList(input, ctx.teamName, {
        memoryStore: store,
      }),
  });

  // 3. memory_save
  tools['memory_save'] = tool({
    description: 'Save or supersede a memory entry for this team',
    inputSchema: MemorySaveInputSchema,
    execute: async (input) =>
      memorySave(input, ctx.teamName, {
        memoryStore: store,
        log: ctx.log,
      }),
  });

  // 4. memory_search
  tools['memory_search'] = tool({
    description: 'Search memory entries by keyword query',
    inputSchema: MemorySearchInputSchema,
    execute: async (input) =>
      memorySearch(input, ctx.teamName, {
        memoryStore: store,
      }),
  });

  return tools;
}
