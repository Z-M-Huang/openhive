/**
 * get_status tool — returns status of caller's team or a specific child team.
 *
 * Input: {team?: string}
 * If team specified, must be caller's child. Returns queue depth, current task, status.
 */

import { z } from 'zod';
import type { OrgTree } from '../../domain/org-tree.js';
import type { ITaskQueueStore } from '../../domain/interfaces.js';
import { TaskStatus } from '../../domain/types.js';

export const GetStatusInputSchema = z.object({
  team: z.string().optional(),
});

export type GetStatusInput = z.infer<typeof GetStatusInputSchema>;

export interface TeamStatusInfo {
  readonly teamId: string;
  readonly name: string;
  readonly status: string;
  readonly queueDepth: number;
  readonly currentTask: string | null;
  readonly pendingCount: number;
  readonly latestResult: string | null;
}

export interface GetStatusResult {
  readonly success: boolean;
  readonly teams?: TeamStatusInfo[];
  readonly error?: string;
}

export interface GetStatusDeps {
  readonly orgTree: OrgTree;
  readonly taskQueue: ITaskQueueStore;
}

export function getStatus(
  input: GetStatusInput,
  callerId: string,
  deps: GetStatusDeps,
): GetStatusResult {
  const parsed = GetStatusInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: `invalid input: ${parsed.error.message}` };
  }

  const { team } = parsed.data;

  if (team) {
    // Specific team — must be caller's child
    const targetTeam = deps.orgTree.getTeam(team);
    if (!targetTeam) {
      return { success: false, error: `team "${team}" not found` };
    }
    if (targetTeam.parentId !== callerId) {
      return { success: false, error: 'target team is not a child of caller' };
    }
    return { success: true, teams: [buildStatusInfo(team, deps)] };
  }

  // Return status for all caller's children
  const children = deps.orgTree.getChildren(callerId);
  const teams = children.map((child) => buildStatusInfo(child.teamId, deps));

  return { success: true, teams };
}

/** Check if a task's options JSON has `internal: true`. */
function isInternalTask(options: string | null): boolean {
  if (!options) return false;
  try {
    const parsed = JSON.parse(options) as Record<string, unknown>;
    return parsed['internal'] === true;
  } catch {
    return false;
  }
}

function buildStatusInfo(teamId: string, deps: GetStatusDeps): TeamStatusInfo {
  const team = deps.orgTree.getTeam(teamId);
  const tasks = deps.taskQueue.getByTeam(teamId);

  const runningTask = tasks.find((t) => t.status === TaskStatus.Running);
  const pendingTasks = tasks.filter((t) => t.status === TaskStatus.Pending);
  const completed = tasks.filter((t) => t.status === TaskStatus.Completed || t.status === TaskStatus.Failed);
  const latest = completed.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  // Redact internal tasks (e.g. bootstrap) — hide implementation details from parent agents
  const currentTask = runningTask
    ? isInternalTask(runningTask.options) ? '(initializing)' : runningTask.task
    : null;

  let latestResult: string | null = null;
  if (latest) {
    if (isInternalTask(latest.options)) {
      latestResult = latest.status === TaskStatus.Completed
        ? 'Bootstrapped successfully'
        : 'Bootstrap failed';
    } else {
      latestResult = latest.result ?? null;
    }
  }

  return {
    teamId,
    name: team?.name ?? teamId,
    status: team?.status ?? 'unknown',
    queueDepth: tasks.length,
    currentTask,
    pendingCount: pendingTasks.length,
    latestResult,
  };
}
