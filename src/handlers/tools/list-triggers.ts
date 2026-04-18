/**
 * list_triggers tool — list triggers and their states for a team.
 */

import { z } from 'zod';
import type { OrgTree } from '../../domain/org-tree.js';
import type { ITriggerConfigStore } from '../../domain/interfaces.js';

export const ListTriggersInputSchema = z.object({
  team: z.string().min(1),
});

export interface TriggerInfo {
  readonly name: string;
  readonly type: string;
  readonly state: string;
  readonly task: string;
  readonly subagent?: string;
  readonly maxSteps: number;
  readonly consecutiveFailures: number;
  readonly disabledReason?: string;
  readonly overlapPolicy?: string;
  readonly overlapCount?: number;
  readonly activeTaskId?: string | null;
}

export interface ListTriggersResult {
  readonly success: boolean;
  readonly triggers?: TriggerInfo[];
  readonly error?: string;
}

export interface ListTriggersDeps {
  readonly orgTree: OrgTree;
  readonly configStore: ITriggerConfigStore;
}

export function listTriggers(
  input: z.infer<typeof ListTriggersInputSchema>,
  callerId: string,
  deps: ListTriggersDeps,
): ListTriggersResult {
  const team = deps.orgTree.getTeam(input.team);
  if (!team) return { success: false, error: `team "${input.team}" not found` };
  if (callerId !== 'root' && team.parentId !== callerId)
    return { success: false, error: 'caller is not parent of target team' };

  const configs = deps.configStore.getByTeam(input.team);
  const triggers: TriggerInfo[] = configs.map(c => ({
    name: c.name,
    type: c.type,
    state: c.state ?? 'pending',
    task: c.task,
    subagent: c.subagent,
    maxSteps: c.maxSteps ?? 100,
    consecutiveFailures: c.consecutiveFailures ?? 0,
    disabledReason: c.disabledReason,
    overlapPolicy: c.overlapPolicy ?? 'skip-then-replace',
    overlapCount: c.overlapCount ?? 0,
    activeTaskId: c.activeTaskId ?? null,
  }));

  return { success: true, triggers };
}
