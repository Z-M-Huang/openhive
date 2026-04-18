/**
 * get_status tool — returns status of caller's team or a specific child team.
 *
 * Input: {team?: string}
 * If team specified, must be caller's child. Returns queue depth, current task, status.
 */

import { z } from 'zod';
import type { OrgTree } from '../../domain/org-tree.js';
import type { ITaskQueueStore, IConcurrencyManager } from '../../domain/interfaces.js';
import { TaskStatus } from '../../domain/types.js';

export const GetStatusInputSchema = z.object({
  team: z.string().optional(),
});

export type GetStatusInput = z.infer<typeof GetStatusInputSchema>;

/**
 * Per-team status block returned by `get_status`.
 *
 * Shape matches wiki [[Organization-Tools#get_status]] verbatim:
 *   { teamId, name, status, active_daily_ops, saturation, org_op_pending,
 *     queue_depth, current_task?, pending_tasks[] }
 *
 * `saturation` is strictly `active_daily_ops >= max_concurrent_daily_ops`
 * (boolean, never a ratio — ADR-41 / wiki §get_status).
 */
export interface TeamStatusInfo {
  readonly teamId: string;
  readonly name: string;
  readonly status: string;
  readonly active_daily_ops: number;
  readonly saturation: boolean;
  readonly org_op_pending: boolean;
  readonly queue_depth: number;
  readonly current_task: string | null;
  readonly pending_tasks: readonly string[];
}

export interface GetStatusResult {
  readonly success: boolean;
  readonly teams?: TeamStatusInfo[];
  readonly error?: string;
}

export interface GetStatusDeps {
  readonly orgTree: OrgTree;
  readonly taskQueue: ITaskQueueStore;
  /** Live concurrency manager — injected from session context (ADR-41, AC-59). */
  readonly concurrencyManager?: IConcurrencyManager;
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

function buildStatusInfo(teamId: string, deps: GetStatusDeps): TeamStatusInfo {
  const team = deps.orgTree.getTeam(teamId);
  const tasks = deps.taskQueue.getByTeam(teamId);

  const runningTask = tasks.find((t) => t.status === TaskStatus.Running);
  const pendingTasks = tasks.filter((t) => t.status === TaskStatus.Pending);

  // Redact bootstrap tasks — hide implementation details from parent agents
  const currentTask = runningTask
    ? runningTask.type === 'bootstrap' ? '(initializing)' : runningTask.task
    : null;

  // Concurrency snapshot is PER-TARGET (ADR-41, AC-54): one saturated team
  // must not mask another. Falls back to a zeroed snapshot when the manager
  // is not wired (tests, bootstrap path).
  const snapshot = deps.concurrencyManager?.getSnapshot(teamId) ?? {
    active_daily_ops: 0,
    saturation: false,
    org_op_pending: false,
  };

  return {
    teamId,
    name: team?.name ?? teamId,
    status: team?.status ?? 'unknown',
    active_daily_ops: snapshot.active_daily_ops,
    saturation: snapshot.saturation,
    org_op_pending: snapshot.org_op_pending,
    queue_depth: tasks.length,
    current_task: currentTask,
    pending_tasks: pendingTasks.map((t) => t.task),
  };
}
