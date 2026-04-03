/**
 * disable_trigger tool — deactivate a trigger and unregister its handler.
 */

import { z } from 'zod';
import type { OrgTree } from '../../domain/org-tree.js';
import type { ITriggerConfigStore } from '../../domain/interfaces.js';
import type { TriggerEngine } from '../../triggers/engine.js';

export const DisableTriggerInputSchema = z.object({
  team: z.string().min(1),
  trigger_name: z.string().min(1),
  reason: z.string().optional(),
});

export interface DisableTriggerResult {
  readonly success: boolean;
  readonly error?: string;
}

export interface DisableTriggerDeps {
  readonly orgTree: OrgTree;
  readonly configStore: ITriggerConfigStore;
  readonly triggerEngine: TriggerEngine;
  readonly log: (msg: string, meta?: Record<string, unknown>) => void;
}

export function disableTrigger(
  input: z.infer<typeof DisableTriggerInputSchema>,
  callerId: string,
  deps: DisableTriggerDeps,
): DisableTriggerResult {
  const team = deps.orgTree.getTeam(input.team);
  if (!team) return { success: false, error: `team "${input.team}" not found` };
  if (callerId !== 'root' && team.parentId !== callerId)
    return { success: false, error: 'caller is not parent of target team' };

  const entry = deps.configStore.get(input.team, input.trigger_name);
  if (!entry) return { success: false, error: `trigger "${input.trigger_name}" not found for team "${input.team}"` };

  deps.configStore.setState(input.team, input.trigger_name, 'disabled', input.reason ?? 'disabled by user');

  // Re-register remaining active triggers for this team
  const active = deps.configStore.getByTeam(input.team).filter(t => t.state === 'active');
  if (active.length > 0) {
    deps.triggerEngine.replaceTeamTriggers(input.team, active);
  } else {
    deps.triggerEngine.removeTeamTriggers(input.team);
  }

  deps.log('Disabled trigger', { team: input.team, trigger: input.trigger_name, reason: input.reason });
  return { success: true };
}
