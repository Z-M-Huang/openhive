/**
 * Recovery + memory persist tests (migrated from layer-10.test.ts)
 *
 * UT-22: Recovery reloads org tree, resets running tasks, detects orphaned teams
 * Memory files persist after recovery
 */

import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createDatabase, createTables } from '../storage/database.js';
import { OrgStore } from '../storage/stores/org-store.js';
import { TaskQueueStore } from '../storage/stores/task-queue-store.js';
import { OrgTree } from '../domain/org-tree.js';
import { TeamStatus, TaskStatus } from '../domain/types.js';
import { recoverFromCrash } from './startup-recovery.js';
import { MemoryStore } from '../storage/stores/memory-store.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function createTempEnv(): {
  dbPath: string;
  dir: string;
  raw: import('better-sqlite3').Database;
  orgStore: OrgStore;
  taskQueueStore: TaskQueueStore;
  orgTree: OrgTree;
  runDir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'openhive-l10-'));
  const dbPath = join(dir, 'test.db');
  const { db, raw } = createDatabase(dbPath);
  createTables(raw);

  const orgStore = new OrgStore(db);
  const taskQueueStore = new TaskQueueStore(db);
  const orgTree = new OrgTree(orgStore);
  const runDir = dir;
  const teamsDir = join(runDir, 'teams');
  mkdirSync(teamsDir, { recursive: true });

  return { dbPath, dir, raw, orgStore, taskQueueStore, orgTree, runDir };
}

const noopLogger = {
  info: () => {},
  warn: () => {},
};

// ── UT-22: Recovery ─────────────────────────────────────────────────────

describe('UT-22: Recovery reloads org tree, resets running tasks, detects orphaned teams', () => {
  it('reloads org tree from SQLite', async () => {
    const { raw, orgStore, taskQueueStore, orgTree, runDir } = createTempEnv();

    orgStore.addTeam({
      teamId: 'team-1',
      name: 'alpha',
      parentId: null,
      status: TeamStatus.Active,
      agents: [],
      children: [],
    });

    // Create config on disk so it's not orphaned
    mkdirSync(join(runDir, 'teams', 'alpha'), { recursive: true });
    writeFileSync(join(runDir, 'teams', 'alpha', 'config.yaml'), 'name: alpha\n');

    const result = recoverFromCrash({
      orgStore,
      taskQueueStore,
      orgTree,
      runDir,
      logger: noopLogger,
    });

    expect(orgTree.getTeam('team-1')).toBeDefined();
    expect(orgTree.getTeam('team-1')?.name).toBe('alpha');
    expect(result.orphaned).toHaveLength(0);

    raw.close();
  });

  it('resets running tasks to pending', async () => {
    const { raw, orgStore, taskQueueStore, orgTree, runDir } = createTempEnv();

    // Enqueue and dequeue (sets to running)
    const taskId1 = taskQueueStore.enqueue('team-1', 'do something', 'normal', 'delegate');
    const taskId2 = taskQueueStore.enqueue('team-1', 'do another', 'high', 'delegate');
    taskQueueStore.dequeue('team-1'); // sets taskId2 to running (high priority first)

    const result = recoverFromCrash({
      orgStore,
      taskQueueStore,
      orgTree,
      runDir,
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
    const { raw, orgStore, taskQueueStore, orgTree, runDir } = createTempEnv();

    taskQueueStore.enqueue('team-alpha', 'task-1', 'normal', 'delegate');
    taskQueueStore.enqueue('team-beta', 'task-2', 'high', 'delegate');

    const result = recoverFromCrash({
      orgStore,
      taskQueueStore,
      orgTree,
      runDir,
      logger: noopLogger,
    });

    expect(result.teamsToReSpawn).toContain('team-alpha');
    expect(result.teamsToReSpawn).toContain('team-beta');
    expect(result.teamsToReSpawn).toHaveLength(2);

    raw.close();
  });

  it('detects orphaned teams (in DB but no config on disk)', async () => {
    const { raw, orgStore, taskQueueStore, orgTree, runDir } = createTempEnv();

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
      runDir,
      logger: noopLogger,
    });

    expect(result.orphaned).toContain('team-orphan');
    expect(result.orphaned).toHaveLength(1);

    raw.close();
  });

  it('handles empty database gracefully', async () => {
    const { raw, orgStore, taskQueueStore, orgTree, runDir } = createTempEnv();

    const result = recoverFromCrash({
      orgStore,
      taskQueueStore,
      orgTree,
      runDir,
      logger: noopLogger,
    });

    expect(result.recovered).toBe(0);
    expect(result.orphaned).toHaveLength(0);
    expect(result.teamsToReSpawn).toHaveLength(0);

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
    const runDir = dir;
    mkdirSync(join(runDir, 'teams'), { recursive: true });

    recoverFromCrash({
      orgStore,
      taskQueueStore,
      orgTree,
      runDir,
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
