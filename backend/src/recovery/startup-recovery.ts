/**
 * Startup recovery -- detects and recovers from unclean shutdowns.
 *
 * Reloads org tree, resets running tasks to pending,
 * identifies teams needing re-spawn, and detects orphaned teams.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { IOrgStore, ITaskQueueStore } from '../domain/interfaces.js';
import { TaskStatus } from '../domain/types.js';
import type { OrgTree } from '../domain/org-tree.js';

export interface RecoveryLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface RecoveryDeps {
  readonly orgStore: IOrgStore;
  readonly taskQueueStore: ITaskQueueStore;
  readonly orgTree: OrgTree;
  readonly teamsDir?: string;
  readonly logger: RecoveryLogger;
}

export interface RecoveryResult {
  readonly recovered: number;
  readonly orphaned: string[];
  readonly teamsToReSpawn: string[];
}

export function recoverFromCrash(deps: RecoveryDeps): RecoveryResult {
  const { orgStore, taskQueueStore, orgTree, logger } = deps;
  const teamsDir = deps.teamsDir ?? '/data/teams';

  // 1. Load org tree from SQLite
  orgTree.loadFromStore();
  const allTeams = orgStore.getAll();
  logger.info('Recovery: loaded org tree', { teamCount: allTeams.length });

  // 2. Find all tasks with status 'running' and reset to 'pending'
  const runningTasks = taskQueueStore.getByStatus(TaskStatus.Running);
  for (const task of runningTasks) {
    taskQueueStore.updateStatus(task.id, TaskStatus.Pending);
  }
  const recovered = runningTasks.length;
  if (recovered > 0) {
    logger.info('Recovery: reset running tasks to pending', { count: recovered });
  }

  // 3. Find teams with pending tasks (candidates for re-spawning)
  const pendingTasks = taskQueueStore.getByStatus(TaskStatus.Pending);
  const teamsWithPending = new Set<string>();
  for (const task of pendingTasks) {
    teamsWithPending.add(task.teamId);
  }
  const teamsToReSpawn = [...teamsWithPending];
  if (teamsToReSpawn.length > 0) {
    logger.info('Recovery: teams with pending tasks', { teams: teamsToReSpawn });
  }

  // 4. Detect orphaned teams: in org_tree but no config on disk
  const orphaned: string[] = [];
  for (const team of allTeams) {
    const configPath = join(teamsDir, team.name, 'config.yaml');
    if (!existsSync(configPath)) {
      orphaned.push(team.teamId);
      logger.warn('Recovery: orphaned team detected', { teamId: team.teamId, name: team.name });
    }
  }

  logger.info('Recovery complete', { recovered, orphaned: orphaned.length, teamsToReSpawn: teamsToReSpawn.length });

  return { recovered, orphaned, teamsToReSpawn };
}
