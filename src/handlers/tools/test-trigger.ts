/**
 * test_trigger tool — fire a trigger once without changing its state.
 * Bypasses dedup and rate limiter. Supports max_steps override.
 */

import { z } from 'zod';
import type { OrgTree } from '../../domain/org-tree.js';
import type { ITriggerConfigStore, ITaskQueueStore } from '../../domain/interfaces.js';
import { checkTeamBusy } from './team-busy-guard.js';
import { TaskStatus } from '../../domain/types.js';

export const TestTriggerInputSchema = z.object({
  team: z.string().min(1),
  trigger_name: z.string().min(1),
  max_steps: z.number().int().min(1).max(500).optional(),
  overlap_policy: z.enum(['allow', 'skip', 'replace', 'confirm']).default('confirm'),
});

export interface InFlightEntry {
  task_id: string;
  type: string;
  status: 'pending' | 'running';
  age_ms: number;
  correlation_id?: string;
  stale?: boolean;
}

export interface TestTriggerResult {
  readonly success: boolean;
  readonly taskId?: string;   // existing — keep name unchanged
  readonly error?: string;
  // Concurrency fields
  readonly enqueued?: boolean;
  readonly requires_confirmation?: boolean;
  readonly overlap_policy_applied?: 'allow' | 'skip' | 'replace' | 'confirm';
  readonly in_flight?: InFlightEntry[];
  readonly reason?: 'replace_targets_running_session';
}

export interface TestTriggerDeps {
  readonly orgTree: OrgTree;
  readonly configStore: ITriggerConfigStore;
  readonly taskQueue: ITaskQueueStore;
  readonly log: (msg: string, meta?: Record<string, unknown>) => void;
}

export function testTrigger(
  input: z.infer<typeof TestTriggerInputSchema>,
  callerId: string,
  deps: TestTriggerDeps,
  sourceChannelId?: string,
): TestTriggerResult {
  const team = deps.orgTree.getTeam(input.team);
  if (!team) return { success: false, error: `team "${input.team}" not found` };
  if (callerId !== 'root' && team.parentId !== callerId)
    return { success: false, error: 'caller is not parent of target team' };

  const entry = deps.configStore.get(input.team, input.trigger_name);
  if (!entry) return { success: false, error: `trigger "${input.trigger_name}" not found for team "${input.team}"` };

  // Check team busy state before enqueueing
  const nowMs = Date.now();
  const busyResult = checkTeamBusy(input.team, deps.taskQueue, { policy: input.overlap_policy });

  const inFlight: InFlightEntry[] = busyResult.inFlight.map((e) => {
    const ageMs = nowMs - new Date(e.createdAt).getTime();
    const mapped: InFlightEntry = {
      task_id: e.id,
      type: e.type,
      status: e.status === TaskStatus.Running ? 'running' : 'pending',
      age_ms: ageMs,
    };
    if (e.correlationId !== null && e.correlationId !== undefined) {
      mapped.correlation_id = e.correlationId;
    }
    if (ageMs > 600_000) {
      mapped.stale = true;
    }
    return mapped;
  });

  // Decision mapping (identical to delegate_task)
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
    const result: TestTriggerResult = {
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
  // Snapshot max_steps at enqueue time (test override > trigger config > default 100)
  const maxSteps = input.max_steps ?? entry.maxSteps ?? 100;

  // Enqueue with test correlation ID (not trigger: prefix — no breaker accounting)
  const correlationId = `test-trigger:${input.trigger_name}:${Date.now()}`;
  const taskId = deps.taskQueue.enqueue(input.team, entry.task, 'normal', 'trigger', sourceChannelId, correlationId, { maxSteps });

  deps.log('Test trigger fired', { team: input.team, trigger: input.trigger_name, taskId, maxSteps });
  return {
    success: true,
    taskId,
    enqueued: true,
    overlap_policy_applied: input.overlap_policy,
    in_flight: inFlight,
  };
}
