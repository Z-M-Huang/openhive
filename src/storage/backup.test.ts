/**
 * Backup + rotation tests (migrated from layer-10.test.ts)
 *
 * - Backup creates valid SQLite copy
 * - Rotates old backups
 * - Creates backup directory if needed
 */

import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { createDatabase, createTables } from './database.js';
import { backupDatabase } from './backup.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function createTempEnv(): {
  dbPath: string;
  dir: string;
  raw: Database.Database;
} {
  const dir = mkdtempSync(join(tmpdir(), 'openhive-l10-'));
  const dbPath = join(dir, 'test.db');
  const { raw } = createDatabase(dbPath);
  createTables(raw);

  return { dbPath, dir, raw };
}

// ── Backup creates valid SQLite copy ────────────────────────────────────

describe('Backup creates valid SQLite copy', () => {
  it('creates a backup file that is a valid SQLite database', async () => {
    const { dbPath, raw } = createTempEnv();
    const backupDir = mkdtempSync(join(tmpdir(), 'openhive-backup-'));

    const backupPath = await backupDatabase(dbPath, backupDir);

    expect(existsSync(backupPath)).toBe(true);

    // Verify the backup is a valid SQLite database
    const backupDb = new Database(backupPath, { readonly: true });
    const result = backupDb.prepare('SELECT 1 as val').get() as { val: number };
    expect(result.val).toBe(1);
    backupDb.close();

    raw.close();
  });

  it('rotates old backups keeping only maxBackups', async () => {
    const { dbPath, raw } = createTempEnv();
    const backupDir = mkdtempSync(join(tmpdir(), 'openhive-rotate-'));

    // Create 5 backups with maxBackups=3
    for (let i = 0; i < 5; i++) {
      await backupDatabase(dbPath, backupDir, 3);
      // Small delay to ensure unique timestamps
      await new Promise((r) => setTimeout(r, 10));
    }

    const files = readdirSync(backupDir).filter((f) => f.startsWith('openhive-backup-'));
    expect(files.length).toBeLessThanOrEqual(3);

    raw.close();
  });

  it('creates backup directory if it does not exist', async () => {
    const { dbPath, raw } = createTempEnv();
    const backupDir = join(mkdtempSync(join(tmpdir(), 'openhive-newdir-')), 'nested', 'backups');

    expect(existsSync(backupDir)).toBe(false);

    await backupDatabase(dbPath, backupDir);

    expect(existsSync(backupDir)).toBe(true);

    raw.close();
  });
});
