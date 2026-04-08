/**
 * vault_get tool handler — retrieves a value from the team vault by key.
 */

import { z } from 'zod';
import type { IVaultStore } from '../../domain/interfaces.js';

export const VaultGetInputSchema = z.object({
  key: z.string().min(1).describe('The vault key to retrieve'),
});

export interface VaultGetResult {
  readonly success: boolean;
  readonly value?: string;
  readonly error?: string;
}

export interface VaultGetDeps {
  readonly vaultStore: IVaultStore;
  readonly log: (msg: string, meta?: Record<string, unknown>) => void;
}

export function vaultGet(
  input: z.infer<typeof VaultGetInputSchema>,
  teamName: string,
  deps: VaultGetDeps,
): VaultGetResult {
  const entry = deps.vaultStore.get(teamName, input.key);
  if (!entry) {
    return { success: false, error: `vault key "${input.key}" not found` };
  }

  deps.log('vault_get', { team: teamName, key: input.key });
  return { success: true, value: entry.value };
}
