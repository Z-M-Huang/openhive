/**
 * delegate_task tool — delegates a task to a child team with scope admission.
 *
 * Input: {team: string, task: string, priority?: 'critical'|'high'|'normal'|'low'}
 * Validates caller is parent. Runs scope admission. Enqueues to priority queue.
 */

import { z } from 'zod';
import type { OrgTree } from '../../domain/org-tree.js';
import type { ITaskQueueStore } from '../../domain/interfaces.js';
import type { TeamConfig } from '../../domain/types.js';
import { checkScopeAdmission } from '../scope-admission.js';

export const DelegateTaskInputSchema = z.object({
  team: z.string().min(1),
  task: z.string().min(1),
  priority: z.enum(['critical', 'high', 'normal', 'low']).default('normal'),
});

export type DelegateTaskInput = z.infer<typeof DelegateTaskInputSchema>;

export interface DelegateTaskResult {
  readonly success: boolean;
  readonly task_id?: string;
  readonly reason?: string;
  readonly team?: string;
}

export interface DelegateTaskDeps {
  readonly orgTree: OrgTree;
  readonly taskQueue: ITaskQueueStore;
  readonly getTeamConfig: (teamId: string) => TeamConfig | undefined;
  readonly log: (msg: string, meta?: Record<string, unknown>) => void;
}

export function delegateTask(
  input: DelegateTaskInput,
  callerId: string,
  deps: DelegateTaskDeps,
): DelegateTaskResult {
  const parsed = DelegateTaskInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, reason: `invalid input: ${parsed.error.message}` };
  }

  const { team, task, priority } = parsed.data;

  // Validate target team exists
  const targetTeam = deps.orgTree.getTeam(team);
  if (!targetTeam) {
    return { success: false, reason: `team "${team}" not found` };
  }

  // Validate caller is parent of target team
  if (targetTeam.parentId !== callerId) {
    return { success: false, reason: 'caller is not parent of target team' };
  }

  // Run scope admission check (fail-closed: reject if config not loadable)
  const config = deps.getTeamConfig(team);
  if (!config) {
    deps.log(`scope check failed: config not loadable for team "${team}"`);
    return { success: false, reason: `config not loadable for team "${team}" — cannot verify scope`, team };
  }
  const admission = checkScopeAdmission(task, config.scope);
  if (!admission.admitted) {
    return { success: false, reason: admission.reason, team };
  }

  // Enqueue task
  const taskId = deps.taskQueue.enqueue(team, task, priority);

  return { success: true, task_id: taskId };
}
