/**
 * Inline vault tool builders — wraps 4 vault handlers as AI SDK inline defs.
 *
 * Returns empty `{}` when `ctx.vaultStore` is undefined.
 */

import { z } from 'zod';
import { tool } from 'ai';
import type { ToolSet } from 'ai';
import type { OrgToolContext } from './org-tool-context.js';

import { VaultSetInputSchema, vaultSet } from '../../handlers/tools/vault-set.js';
import { VaultGetInputSchema, vaultGet } from '../../handlers/tools/vault-get.js';
import { VaultDeleteInputSchema, vaultDelete } from '../../handlers/tools/vault-delete.js';
import { vaultList } from '../../handlers/tools/vault-list.js';

// ── Builder ─────────────────────────────────────────────────────────────────

/**
 * Build the 4 vault tools as AI SDK inline tool definitions.
 * Returns a ToolSet keyed by bare tool name.
 * Returns empty `{}` when `ctx.vaultStore` is undefined.
 */
export function buildVaultTools(
  ctx: OrgToolContext,
): ToolSet {
  if (!ctx.vaultStore) return {};

  const store = ctx.vaultStore;
  const tools: ToolSet = {};

  // 1. vault_set
  tools['vault_set'] = tool({
    description: 'Store a key-value pair in the team vault',
    inputSchema: VaultSetInputSchema,
    execute: async (input) =>
      vaultSet(input, ctx.teamName, {
        vaultStore: store,
        log: ctx.log,
      }),
  });

  // 2. vault_get
  tools['vault_get'] = tool({
    description: 'Retrieve a value from the team vault by key',
    inputSchema: VaultGetInputSchema,
    execute: async (input) =>
      vaultGet(input, ctx.teamName, {
        vaultStore: store,
        log: ctx.log,
      }),
  });

  // 3. vault_list
  tools['vault_list'] = tool({
    description: 'List all vault entries for this team',
    inputSchema: z.object({}),
    execute: async () =>
      vaultList(ctx.teamName, {
        vaultStore: store,
      }),
  });

  // 4. vault_delete
  tools['vault_delete'] = tool({
    description: 'Delete a vault entry by key',
    inputSchema: VaultDeleteInputSchema,
    execute: async (input) =>
      vaultDelete(input, ctx.teamName, {
        vaultStore: store,
      }),
  });

  return tools;
}
