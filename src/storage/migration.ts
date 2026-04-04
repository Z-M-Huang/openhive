/**
 * Filesystem → SQLite memory migration.
 *
 * One-time, idempotent scan of .run/teams/{team}/memory/ directories.
 * Migrates MEMORY.md content, .bootstrapped markers, and init-context.md.
 * Does NOT delete filesystem files (leaves them orphaned safely).
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { IMemoryStore } from '../domain/interfaces.js';
import type { OrgTree } from '../domain/org-tree.js';
import { errorMessage } from '../domain/errors.js';

export function migrateFilesystemMemory(
  memoryStore: IMemoryStore,
  orgTree: OrgTree,
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

  for (const teamName of teamDirs) {
    const memoryDir = join(teamsDir, teamName, 'memory');
    if (!existsSync(memoryDir)) continue;

    try {
      // 1. MEMORY.md migration
      const memoryMdPath = join(memoryDir, 'MEMORY.md');
      if (existsSync(memoryMdPath)) {
        const content = readFileSync(memoryMdPath, 'utf-8');
        if (content.trim().length > 0) {
          try {
            memoryStore.save(teamName, 'legacy-memory', content, 'context', undefined, 'migration-v4.2');
            log('Migrated MEMORY.md', { team: teamName });
          } catch (err) {
            // Active entry already exists = already migrated. Skip.
            const msg = errorMessage(err);
            if (!msg.includes('Active entry exists')) {
              log('MEMORY.md migration failed', { team: teamName, error: msg });
            }
          }
        }
      }

      // 2. .bootstrapped migration
      const bootstrappedPath = join(memoryDir, '.bootstrapped');
      if (existsSync(bootstrappedPath)) {
        orgTree.setBootstrapped(teamName);
        log('Set bootstrapped from file marker', { team: teamName });
      }

      // 3. init-context.md migration
      const initContextPath = join(memoryDir, 'init-context.md');
      if (existsSync(initContextPath)) {
        const teamRulesDir = join(teamsDir, teamName, 'team-rules');
        const teamContextPath = join(teamRulesDir, 'team-context.md');
        if (!existsSync(teamContextPath)) {
          mkdirSync(teamRulesDir, { recursive: true });
          const initContent = readFileSync(initContextPath, 'utf-8');
          writeFileSync(teamContextPath, initContent, 'utf-8');
          log('Moved init-context.md to team-rules/', { team: teamName });
        }
      }
    } catch (err) {
      // One team's failure doesn't block others
      log('Migration failed for team', { team: teamName, error: errorMessage(err) });
    }
  }
}
