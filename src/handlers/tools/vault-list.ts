/**
 * vault_list tool handler — lists vault entries for a team.
 *
 * Returns key + isSecret for all entries.
 * Values are omitted for entries where isSecret=true (privacy).
 */

import type { IVaultStore } from '../../domain/interfaces.js';

export interface VaultListItem {
  readonly key: string;
  readonly isSecret: boolean;
  readonly value?: string;
}

export interface VaultListDeps {
  readonly vaultStore: IVaultStore;
}

export function vaultList(
  teamName: string,
  deps: VaultListDeps,
): VaultListItem[] {
  const entries = deps.vaultStore.list(teamName);
  return entries.map((e) => ({
    key: e.key,
    isSecret: e.isSecret,
    ...(e.isSecret ? {} : { value: e.value }),
  }));
}
