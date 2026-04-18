/**
 * create_trigger tool — register a new trigger in pending state.
 */

import { z } from 'zod';
import type { OrgTree } from '../../domain/org-tree.js';
import type { ITriggerConfigStore } from '../../domain/interfaces.js';
import { validateSubagent, type LoadSubagentsFn } from './validate-subagent.js';

/**
 * Reserved trigger-name prefixes. Learning/reflection cycles are seeded by the
 * system (bootstrap-helpers.seedLearningTrigger / seedReflectionTrigger) and
 * must not collide with user-created triggers — the api/learning dashboard
 * uses name-prefix matching to surface them.
 */
export const RESERVED_TRIGGER_NAME_RE = /^(learning|reflection)-cycle(-|$)/;

export const CreateTriggerInputSchema = z.object({
  team: z.string().min(1),
  name: z.string().min(1).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'trigger name must be a lowercase slug'),
  type: z.enum(['schedule', 'keyword', 'message', 'window']),
  config: z.record(z.unknown()),
  task: z.string().min(1),
  subagent: z.string().min(1).optional(),
  max_steps: z.number().int().min(1).max(500).optional(),
  failure_threshold: z.number().int().min(1).max(100).optional(),
  overlap_policy: z.enum(['skip-then-replace', 'always-skip', 'always-replace', 'allow']).default('skip-then-replace').optional(),
});

export interface CreateTriggerResult {
  readonly success: boolean;
  readonly error?: string;
}

export interface CreateTriggerDeps {
  readonly orgTree: OrgTree;
  readonly configStore: ITriggerConfigStore;
  readonly runDir: string;
  readonly loadSubagents: LoadSubagentsFn;
  readonly log: (msg: string, meta?: Record<string, unknown>) => void;
}

export function createTrigger(
  input: z.infer<typeof CreateTriggerInputSchema>,
  callerId: string,
  deps: CreateTriggerDeps,
  sourceChannelId?: string,
): CreateTriggerResult {
  const team = deps.orgTree.getTeam(input.team);
  if (!team) return { success: false, error: `team "${input.team}" not found` };
  if (callerId !== 'root' && team.parentId !== callerId)
    return { success: false, error: 'caller is not parent of target team' };

  if (RESERVED_TRIGGER_NAME_RE.test(input.name)) {
    return {
      success: false,
      error: `trigger name "${input.name}" is reserved — learning-cycle* and reflection-cycle* names are system-seeded`,
    };
  }

  const existing = deps.configStore.get(input.team, input.name);
  if (existing) return { success: false, error: `trigger "${input.name}" already exists for team "${input.team}"` };

  const subagentCheck = validateSubagent(input.subagent, input.team, deps.runDir, deps.loadSubagents);
  if (!subagentCheck.ok) return { success: false, error: subagentCheck.error };

  deps.configStore.upsert({
    name: input.name,
    type: input.type,
    config: input.config,
    team: input.team,
    task: input.task,
    subagent: input.subagent,
    state: 'pending',
    maxSteps: input.max_steps ?? 100,
    failureThreshold: input.failure_threshold ?? 3,
    sourceChannelId,
    overlapPolicy: input.overlap_policy,
  });

  deps.log('Created trigger', {
    team: input.team,
    trigger: input.name,
    state: 'pending',
    subagent: input.subagent,
  });
  return { success: true };
}
