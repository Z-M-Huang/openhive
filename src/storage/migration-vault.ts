/**
 * Config.yaml → Vault credential migration.
 *
 * Scans all team config.yaml files under {runDir}/teams/ and inserts
 * each credential into the vault as is_secret=1 (config-yaml-wins:
 * each bootstrap run overwrites vault from config). Idempotent.
 * Does NOT remove credentials from config.yaml (backward compat).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as yamlParse } from 'yaml';
import type { IVaultStore } from '../domain/interfaces.js';

export function migrateCredentialsToVault(
  vaultStore: IVaultStore,
  runDir: string,
  log: (msg: string, meta?: Record<string, unknown>) => void,
): void {
  const teamsDir = join(runDir, 'teams');
  if (!existsSync(teamsDir)) return;

  let teamDirs: string[];
  try {
    teamDirs = readdirSync(teamsDir);
  } catch {
    return;
  }

  let migrated = 0;

  for (const teamName of teamDirs) {
    const configPath = join(teamsDir, teamName, 'config.yaml');
    if (!existsSync(configPath)) continue;

    let raw: string;
    try {
      raw = readFileSync(configPath, 'utf-8');
    } catch {
      continue;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = yamlParse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }

    const credentials = parsed['credentials'];
    if (!credentials || typeof credentials !== 'object') continue;

    for (const [key, value] of Object.entries(credentials as Record<string, unknown>)) {
      if (typeof value !== 'string') continue;
      vaultStore.set(teamName, key, value, true, 'config-migration');
      migrated++;
    }
  }

  if (migrated > 0) {
    log('Vault migration: migrated credentials from config.yaml', { count: migrated });
  }
}
