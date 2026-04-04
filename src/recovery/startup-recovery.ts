/**
 * Startup recovery -- detects and recovers from unclean shutdowns.
 *
 * Reloads org tree, resets running tasks to pending,
 * identifies teams needing re-spawn, and detects orphaned teams.
 * Team configs live under {runDir}/teams/{name}/config.yaml.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { IOrgStore, ITaskQueueStore, ITopicStore } from '../domain/interfaces.js';
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
  readonly runDir: string;
  readonly logger: RecoveryLogger;
  readonly topicStore?: ITopicStore;
}

export interface RecoveryResult {
  readonly recovered: number;
  readonly orphaned: string[];
  readonly teamsToReSpawn: string[];
}

export function recoverFromCrash(deps: RecoveryDeps): RecoveryResult {
  const { orgStore, taskQueueStore, orgTree, runDir, logger } = deps;

  // 1. Load org tree from SQLite
  orgTree.loadFromStore();
  const allTeams = orgStore.getAll();
  logger.info('Recovery: loaded org tree', { teamCount: allTeams.length });

  // 2. Find all tasks with status 'running' and reset to 'pending'
  const runningTasks = taskQueueStore.getByStatus(TaskStatus.Running);
  for (const task of runningTasks) {
    taskQueueStore.updateStatus(task.id, TaskStatus.Pending);
  }
  let recovered = runningTasks.length;
  if (recovered > 0) {
    logger.info('Recovery: reset running tasks to pending', { count: recovered });
  }

  // 2b. Reset failed bootstrap tasks to pending (so teams can retry initialization)
  const failedTasks = taskQueueStore.getByStatus(TaskStatus.Failed);
  const failedInits = failedTasks.filter(
    t => t.priority === 'critical' && t.task.startsWith('Bootstrap'),
  );
  for (const task of failedInits) {
    taskQueueStore.updateStatus(task.id, TaskStatus.Pending);
    recovered++;
  }
  if (failedInits.length > 0) {
    logger.info('Recovery: reset failed bootstrap tasks to pending', { count: failedInits.length });
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
    const configPath = join(runDir, 'teams', team.name, 'config.yaml');
    if (!existsSync(configPath)) {
      orphaned.push(team.teamId);
      logger.warn('Recovery: orphaned team detected', { teamId: team.teamId, name: team.name });
    }
  }

  // 5. Mark all active topics as idle (clean slate after crash)
  if (deps.topicStore) {
    const idled = deps.topicStore.markAllIdle();
    if (idled > 0) logger.info('Recovery: marked active topics as idle', { count: idled });
  }

  logger.info('Recovery complete', { recovered, orphaned: orphaned.length, teamsToReSpawn: teamsToReSpawn.length });

  return { recovered, orphaned, teamsToReSpawn };
}
