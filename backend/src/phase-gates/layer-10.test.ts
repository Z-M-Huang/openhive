/**
 * Layer 10 Phase Gate -- Recovery + Backup
 *
 * Tests:
 * - UT-22: Recovery reloads org tree, resets running tasks, detects orphaned teams
 * - Backup creates valid SQLite copy, rotates old backups
 * - Memory files persist after recovery
 */

import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { createDatabase, createTables } from '../storage/database.js';
import { OrgStore } from '../storage/stores/org-store.js';
import { TaskQueueStore } from '../storage/stores/task-queue-store.js';
import { OrgTree } from '../domain/org-tree.js';
import { TeamStatus, TaskStatus, TaskPriority } from '../domain/types.js';
import { recoverFromCrash } from '../recovery/startup-recovery.js';
import { backupDatabase } from '../storage/backup.js';
import { MemoryStore } from '../storage/stores/memory-store.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function createTempEnv(): {
  dbPath: string;
  dir: string;
  raw: Database.Database;
  orgStore: OrgStore;
  taskQueueStore: TaskQueueStore;
  orgTree: OrgTree;
  teamsDir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'openhive-l10-'));
  const dbPath = join(dir, 'test.db');
  const { db, raw } = createDatabase(dbPath);
  createTables(raw);

  const orgStore = new OrgStore(db);
  const taskQueueStore = new TaskQueueStore(db);
  const orgTree = new OrgTree(orgStore);
  const teamsDir = join(dir, 'teams');
  mkdirSync(teamsDir, { recursive: true });

  return { dbPath, dir, raw, orgStore, taskQueueStore, orgTree, teamsDir };
}

const noopLogger = {
  info: () => {},
  warn: () => {},
};

// ── UT-22: Recovery ─────────────────────────────────────────────────────

describe('UT-22: Recovery reloads org tree, resets running tasks, detects orphaned teams', () => {
  it('reloads org tree from SQLite', async () => {
    const { raw, orgStore, taskQueueStore, orgTree, teamsDir } = createTempEnv();

    orgStore.addTeam({
      teamId: 'team-1',
      name: 'alpha',
      parentId: null,
      status: TeamStatus.Active,
      agents: [],
      children: [],
    });

    // Create config on disk so it's not orphaned
    mkdirSync(join(teamsDir, 'alpha'), { recursive: true });
    writeFileSync(join(teamsDir, 'alpha', 'config.yaml'), 'name: alpha\n');

    const result = recoverFromCrash({
      orgStore,
      taskQueueStore,
      orgTree,
      teamsDir,
      logger: noopLogger,
    });

    expect(orgTree.getTeam('team-1')).toBeDefined();
    expect(orgTree.getTeam('team-1')?.name).toBe('alpha');
    expect(result.orphaned).toHaveLength(0);

    raw.close();
  });

  it('resets running tasks to pending', async () => {
    const { raw, orgStore, taskQueueStore, orgTree, teamsDir } = createTempEnv();

    // Enqueue and dequeue (sets to running)
    const taskId1 = taskQueueStore.enqueue('team-1', 'do something', TaskPriority.Normal);
    const taskId2 = taskQueueStore.enqueue('team-1', 'do another', TaskPriority.High);
    taskQueueStore.dequeue('team-1'); // sets taskId2 to running (high priority first)

    const result = recoverFromCrash({
      orgStore,
      taskQueueStore,
      orgTree,
      teamsDir,
      logger: noopLogger,
    });

    expect(result.recovered).toBe(1);

    // Both tasks should now be pending
    const pending = taskQueueStore.getByStatus(TaskStatus.Pending);
    expect(pending).toHaveLength(2);

    // Verify the dequeued task is back to pending
    const tasks = taskQueueStore.getByTeam('team-1');
    const resetTask = tasks.find((t) => t.status === TaskStatus.Running);
    expect(resetTask).toBeUndefined();

    void taskId1;
    void taskId2;
    raw.close();
  });

  it('identifies teams with pending tasks for re-spawning', async () => {
    const { raw, orgStore, taskQueueStore, orgTree, teamsDir } = createTempEnv();

    taskQueueStore.enqueue('team-alpha', 'task-1', TaskPriority.Normal);
    taskQueueStore.enqueue('team-beta', 'task-2', TaskPriority.High);

    const result = recoverFromCrash({
      orgStore,
      taskQueueStore,
      orgTree,
      teamsDir,
      logger: noopLogger,
    });

    expect(result.teamsToReSpawn).toContain('team-alpha');
    expect(result.teamsToReSpawn).toContain('team-beta');
    expect(result.teamsToReSpawn).toHaveLength(2);

    raw.close();
  });

  it('detects orphaned teams (in DB but no config on disk)', async () => {
    const { raw, orgStore, taskQueueStore, orgTree, teamsDir } = createTempEnv();

    orgStore.addTeam({
      teamId: 'team-orphan',
      name: 'orphan-team',
      parentId: null,
      status: TeamStatus.Idle,
      agents: [],
      children: [],
    });

    // Deliberately do NOT create config on disk

    const result = recoverFromCrash({
      orgStore,
      taskQueueStore,
      orgTree,
      teamsDir,
      logger: noopLogger,
    });

    expect(result.orphaned).toContain('team-orphan');
    expect(result.orphaned).toHaveLength(1);

    raw.close();
  });

  it('handles empty database gracefully', async () => {
    const { raw, orgStore, taskQueueStore, orgTree, teamsDir } = createTempEnv();

    const result = recoverFromCrash({
      orgStore,
      taskQueueStore,
      orgTree,
      teamsDir,
      logger: noopLogger,
    });

    expect(result.recovered).toBe(0);
    expect(result.orphaned).toHaveLength(0);
    expect(result.teamsToReSpawn).toHaveLength(0);

    raw.close();
  });
});

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

// ── Memory files persist after recovery ─────────────────────────────────

describe('Memory files persist after recovery', () => {
  it('memory store files survive recovery process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openhive-mem-'));
    const memoryBaseDir = join(dir, 'teams');
    const memoryStore = new MemoryStore(memoryBaseDir);

    // Write memory files
    memoryStore.writeFile('test-team', 'context.md', '# Team Context\nSome important notes');
    memoryStore.writeFile('test-team', 'history.md', '## History\nPrevious decisions');

    // Simulate recovery (memory store is filesystem-based, so files survive)
    const dbPath = join(dir, 'test.db');
    const { db, raw } = createDatabase(dbPath);
    createTables(raw);
    const orgStore = new OrgStore(db);
    const taskQueueStore = new TaskQueueStore(db);
    const orgTree = new OrgTree(orgStore);
    const teamsDir = join(dir, 'cfg-teams');
    mkdirSync(teamsDir, { recursive: true });

    recoverFromCrash({
      orgStore,
      taskQueueStore,
      orgTree,
      teamsDir,
      logger: noopLogger,
    });

    // Verify memory files still exist
    const context = memoryStore.readFile('test-team', 'context.md');
    expect(context).toBe('# Team Context\nSome important notes');

    const history = memoryStore.readFile('test-team', 'history.md');
    expect(history).toBe('## History\nPrevious decisions');

    const files = memoryStore.listFiles('test-team');
    expect(files).toContain('context.md');
    expect(files).toContain('history.md');

    raw.close();
  });
});
