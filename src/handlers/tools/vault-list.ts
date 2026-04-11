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
  prefix?: string,
): VaultListItem[] {
  let entries = deps.vaultStore.list(teamName);
  if (prefix) entries = entries.filter((e) => e.key.startsWith(prefix));
  return entries.map((e) => ({
    key: e.key,
    isSecret: e.isSecret,
    ...(e.isSecret ? {} : { value: e.value }),
  }));
}
