/**
 * test_trigger tool — fire a trigger once without changing its state.
 * Bypasses dedup and rate limiter. Supports max_turns override.
 */

import { z } from 'zod';
import type { OrgTree } from '../../domain/org-tree.js';
import type { ITriggerConfigStore, ITaskQueueStore } from '../../domain/interfaces.js';

export const TestTriggerInputSchema = z.object({
  team: z.string().min(1),
  trigger_name: z.string().min(1),
  max_turns: z.number().int().min(1).max(500).optional(),
});

export interface TestTriggerResult {
  readonly success: boolean;
  readonly taskId?: string;
  readonly error?: string;
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

  // Snapshot max_turns at enqueue time (test override > trigger config > default 100)
  const maxTurns = input.max_turns ?? entry.maxTurns ?? 100;

  // Enqueue with test correlation ID (not trigger: prefix — no breaker accounting)
  const correlationId = `test-trigger:${input.trigger_name}:${Date.now()}`;
  const taskId = deps.taskQueue.enqueue(input.team, entry.task, 'normal', 'trigger', sourceChannelId, correlationId, { maxTurns });

  deps.log('Test trigger fired', { team: input.team, trigger: input.trigger_name, taskId, maxTurns });
  return { success: true, taskId };
}
