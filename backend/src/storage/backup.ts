/**
 * SQLite database backup with rotation.
 *
 * Uses better-sqlite3's .backup() for online backup.
 * Keeps the last N backups and deletes oldest.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_MAX_BACKUPS = 7;
const BACKUP_PREFIX = 'openhive-backup-';
const BACKUP_SUFFIX = '.db';

export async function backupDatabase(
  dbPath: string,
  backupDir: string,
  maxBackups?: number,
): Promise<string> {
  const max = maxBackups ?? DEFAULT_MAX_BACKUPS;

  // Ensure backup directory exists
  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true });
  }

  // Create backup with ISO date in filename
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupName = `${BACKUP_PREFIX}${timestamp}${BACKUP_SUFFIX}`;
  const backupPath = join(backupDir, backupName);

  const source = new Database(dbPath, { readonly: true });
  try {
    await source.backup(backupPath);
  } finally {
    source.close();
  }

  // Rotate: keep only last N backups
  const files = readdirSync(backupDir)
    .filter((f) => f.startsWith(BACKUP_PREFIX) && f.endsWith(BACKUP_SUFFIX))
    .sort();

  if (files.length > max) {
    const toDelete = files.slice(0, files.length - max);
    for (const file of toDelete) {
      unlinkSync(join(backupDir, file));
    }
  }

  return backupPath;
}
