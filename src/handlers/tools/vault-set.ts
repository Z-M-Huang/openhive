/**
 * vault_set tool handler — stores a key-value pair in the team vault.
 *
 * Rejects overwrite when the existing entry has is_secret=true
 * (system-managed secrets cannot be modified by agents).
 * New entries created via this tool always have is_secret=false.
 */

import { z } from 'zod';
import type { IVaultStore } from '../../domain/interfaces.js';
import type { VaultEntry } from '../../domain/types.js';

export const VaultSetInputSchema = z.object({
  key: z.string().min(1).describe('The vault key to set'),
  value: z.string().min(1).describe('The value to store'),
});

export interface VaultSetResult {
  readonly success: boolean;
  readonly entry?: VaultEntry;
  readonly error?: string;
}

export interface VaultSetDeps {
  readonly vaultStore: IVaultStore;
  readonly log: (msg: string, meta?: Record<string, unknown>) => void;
}

export function vaultSet(
  input: z.infer<typeof VaultSetInputSchema>,
  teamName: string,
  deps: VaultSetDeps,
): VaultSetResult {
  const existing = deps.vaultStore.get(teamName, input.key);
  if (existing && existing.isSecret) {
    return { success: false, error: `cannot overwrite system-managed secret "${input.key}"` };
  }

  const entry = deps.vaultStore.set(teamName, input.key, input.value, false);
  deps.log('vault_set', { team: teamName, key: input.key });
  return { success: true, entry };
}
