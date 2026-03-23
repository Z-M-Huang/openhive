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

function buildStatusInfo(teamId: string, deps: GetStatusDeps): TeamStatusInfo {
  const team = deps.orgTree.getTeam(teamId);
  const tasks = deps.taskQueue.getByTeam(teamId);

  const runningTask = tasks.find((t) => t.status === TaskStatus.Running);
  const pendingTasks = tasks.filter((t) => t.status === TaskStatus.Pending);

  return {
    teamId,
    name: team?.name ?? teamId,
    status: team?.status ?? 'unknown',
    queueDepth: tasks.length,
    currentTask: runningTask?.task ?? null,
    pendingCount: pendingTasks.length,
  };
}
