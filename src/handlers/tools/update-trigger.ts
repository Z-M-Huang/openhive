/**
 * update_trigger tool — modify an existing trigger's config, task, or settings.
 */

import { z } from 'zod';
import { validate as validateCron } from 'node-cron';
import type { OrgTree } from '../../domain/org-tree.js';
import type { ITriggerConfigStore, TriggerConfig } from '../../domain/interfaces.js';
import type { TriggerEngine } from '../../triggers/engine.js';

export const UpdateTriggerInputSchema = z.object({
  team: z.string().min(1),
  trigger_name: z.string().min(1),
  config: z.record(z.unknown()).optional(),
  task: z.string().min(1).optional(),
  max_turns: z.number().int().min(1).max(500).optional(),
  failure_threshold: z.number().int().min(1).max(100).optional(),
  overlap_policy: z.enum(['skip-then-replace', 'always-skip', 'always-replace', 'allow']).optional(),
}).refine(
  (data) => data.config !== undefined || data.task !== undefined ||
            data.max_turns !== undefined || data.failure_threshold !== undefined ||
            data.overlap_policy !== undefined,
  { message: 'at least one updatable field must be provided' },
);

export interface UpdateTriggerResult {
  readonly success: boolean;
  readonly error?: string;
  readonly trigger_name?: string;
}

export interface UpdateTriggerDeps {
  readonly orgTree: OrgTree;
  readonly configStore: ITriggerConfigStore;
  readonly triggerEngine?: TriggerEngine;
  readonly log: (msg: string, meta?: Record<string, unknown>) => void;
}

export function updateTrigger(
  input: z.infer<typeof UpdateTriggerInputSchema>,
  callerId: string,
  deps: UpdateTriggerDeps,
): UpdateTriggerResult {
  const parsed = UpdateTriggerInputSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? 'invalid input' };
  const data = parsed.data;

  const team = deps.orgTree.getTeam(data.team);
  if (!team) return { success: false, error: `team "${data.team}" not found` };
  if (callerId !== 'root' && team.parentId !== callerId)
    return { success: false, error: 'caller is not parent of target team' };

  const existing = deps.configStore.get(data.team, data.trigger_name);
  if (!existing) return { success: false, error: `trigger "${data.trigger_name}" not found for team "${data.team}"` };

  // Build merged config explicitly with field-by-field mapping
  const merged: TriggerConfig = {
    name: existing.name,
    type: existing.type,
    team: existing.team,
    config: data.config ?? existing.config,
    task: data.task ?? existing.task,
    skill: existing.skill,
    state: existing.state,
    maxTurns: data.max_turns ?? existing.maxTurns,
    failureThreshold: data.failure_threshold ?? existing.failureThreshold,
    consecutiveFailures: existing.consecutiveFailures,
    sourceChannelId: existing.sourceChannelId,
    overlapPolicy: data.overlap_policy ?? existing.overlapPolicy,
  };

  // Pre-validate config if trigger is active and config was changed
  if (existing.state === 'active' && data.config !== undefined) {
    if (existing.type === 'schedule') {
      const cron = data.config.cron;
      if (typeof cron === 'string' && !validateCron(cron)) {
        return { success: false, error: `invalid cron expression: "${cron}"` };
      }
    }
    if (existing.type === 'keyword' || existing.type === 'message') {
      const pattern = data.config.pattern;
      if (typeof pattern === 'string') {
        try { new RegExp(pattern); } catch {
          return { success: false, error: `invalid regex pattern: "${pattern}"` };
        }
      }
    }
  }

  deps.configStore.upsert(merged);

  // Re-register if active
  if (existing.state === 'active' && deps.triggerEngine) {
    const active = deps.configStore.getByTeam(data.team).filter(t => t.state === 'active');
    deps.triggerEngine.replaceTeamTriggers(data.team, active);
  }

  deps.log('Updated trigger', { team: data.team, trigger: data.trigger_name });
  return { success: true, trigger_name: data.trigger_name };
}
