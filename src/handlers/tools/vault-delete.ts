/**
 * vault_delete tool handler — removes a vault entry by key.
 *
 * Rejects deletion when the entry has is_secret=true
 * (system-managed secrets cannot be deleted by agents).
 */

import { z } from 'zod';
import type { IVaultStore } from '../../domain/interfaces.js';

export const VaultDeleteInputSchema = z.object({
  key: z.string().min(1).describe('The vault key to delete'),
});

export interface VaultDeleteResult {
  readonly success: boolean;
  readonly deleted?: boolean;
  readonly error?: string;
}

export interface VaultDeleteDeps {
  readonly vaultStore: IVaultStore;
}

export function vaultDelete(
  input: z.infer<typeof VaultDeleteInputSchema>,
  teamName: string,
  deps: VaultDeleteDeps,
): VaultDeleteResult {
  const existing = deps.vaultStore.get(teamName, input.key);
  if (!existing) {
    return { success: true, deleted: false };
  }

  if (existing.isSecret) {
    return { success: false, error: `cannot delete system-managed secret "${input.key}"` };
  }

  const deleted = deps.vaultStore.delete(teamName, input.key);
  return { success: true, deleted };
}
