/**
 * delegate_task tool — delegates a task to a child team.
 *
 * Input: {team: string, task: string, priority?: 'critical'|'high'|'normal'|'low', overlap_policy?: 'allow'|'skip'|'replace'|'confirm'}
 * Validates caller is parent. Checks team busy state. Enqueues to priority queue.
 */

import { z } from 'zod';
import type { OrgTree } from '../../domain/org-tree.js';
import type { ITaskQueueStore } from '../../domain/interfaces.js';
import { checkTeamBusy } from './team-busy-guard.js';
import { TaskStatus } from '../../domain/types.js';

export const DelegateTaskInputSchema = z.object({
  team: z.string().min(1),
  task: z.string().min(1),
  priority: z.enum(['critical', 'high', 'normal', 'low']).default('normal'),
  overlap_policy: z.enum(['allow', 'skip', 'replace', 'confirm']).default('confirm'),
});

export type DelegateTaskInput = z.infer<typeof DelegateTaskInputSchema>;

export interface InFlightEntry {
  task_id: string;
  type: 'bootstrap' | 'delegate' | 'trigger' | 'escalation';
  status: 'pending' | 'running';
  age_ms: number;
  correlation_id?: string;
  stale?: boolean;
}

export interface DelegateTaskResult {
  readonly success: boolean;
  readonly task_id?: string;
  readonly reason?: string;
  readonly team?: string;
  // Concurrency fields
  readonly enqueued?: boolean;
  readonly requires_confirmation?: boolean;
  readonly overlap_policy_applied?: 'allow' | 'skip' | 'replace' | 'confirm';
  readonly in_flight?: InFlightEntry[];
  readonly error?: string;
}

export interface DelegateTaskDeps {
  readonly orgTree: OrgTree;
  readonly taskQueue: ITaskQueueStore;
  readonly log: (msg: string, meta?: Record<string, unknown>) => void;
}

export function delegateTask(
  input: DelegateTaskInput,
  callerId: string,
  deps: DelegateTaskDeps,
  sourceChannelId?: string,
): DelegateTaskResult {
  const parsed = DelegateTaskInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, reason: `invalid input: ${parsed.error.message}` };
  }

  const { team, task, priority, overlap_policy } = parsed.data;

  // Validate target team exists
  const targetTeam = deps.orgTree.getTeam(team);
  if (!targetTeam) {
    return { success: false, reason: `team "${team}" not found` };
  }

  // Validate caller is parent of target team
  if (targetTeam.parentId !== callerId) {
    return { success: false, reason: 'caller is not parent of target team' };
  }

  // Check team busy state before enqueueing
  const nowMs = Date.now();
  const busyResult = checkTeamBusy(team, deps.taskQueue, { policy: overlap_policy });

  const inFlight: InFlightEntry[] = busyResult.inFlight.map((entry) => {
    const ageMs = nowMs - new Date(entry.createdAt).getTime();
    const mapped: InFlightEntry = {
      task_id: entry.id,
      type: entry.type,
      status: entry.status === TaskStatus.Running ? 'running' : 'pending',
      age_ms: ageMs,
    };
    if (entry.correlationId !== null && entry.correlationId !== undefined) {
      mapped.correlation_id = entry.correlationId;
    }
    if (ageMs > 600_000) {
      mapped.stale = true;
    }
    return mapped;
  });

  // Decision mapping
  const { decision } = busyResult;

  if (decision === 'skip') {
    return {
      success: true,
      enqueued: false,
      overlap_policy_applied: 'skip',
      in_flight: inFlight,
    };
  }

  if (decision === 'needs_confirmation') {
    const result: DelegateTaskResult = {
      success: true,
      enqueued: false,
      requires_confirmation: true,
      overlap_policy_applied: 'confirm',
      in_flight: inFlight,
    };
    if (busyResult.reason) {
      return { ...result, reason: busyResult.reason };
    }
    return result;
  }

  // decision === 'proceed': enqueue
  const taskId = deps.taskQueue.enqueue(team, task, priority, 'delegate', sourceChannelId);

  return {
    success: true,
    task_id: taskId,
    enqueued: true,
    overlap_policy_applied: overlap_policy,
    in_flight: inFlight,
  };
}
