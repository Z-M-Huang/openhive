/**
 * update_team tool — modify a child team's scope keywords.
 */

import { z } from 'zod';
import type { OrgTree } from '../../domain/org-tree.js';

export const UpdateTeamInputSchema = z.object({
  team: z.string().min(1),
  scope_add: z.array(z.string().trim().min(1)).optional(),
  scope_remove: z.array(z.string().trim().min(1)).optional(),
}).refine(
  (data) => (data.scope_add?.length ?? 0) > 0 || (data.scope_remove?.length ?? 0) > 0,
  { message: 'at least one of scope_add or scope_remove is required' },
);

export interface UpdateTeamResult {
  readonly success: boolean;
  readonly error?: string;
  readonly scope?: string[];
}

export interface UpdateTeamDeps {
  readonly orgTree: OrgTree;
  readonly log: (msg: string, meta?: Record<string, unknown>) => void;
}

export function updateTeam(
  input: z.infer<typeof UpdateTeamInputSchema>,
  callerId: string,
  deps: UpdateTeamDeps,
): UpdateTeamResult {
  const parsed = UpdateTeamInputSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? 'invalid input' };
  const data = parsed.data;

  const team = deps.orgTree.getTeam(data.team);
  if (!team) return { success: false, error: `team "${data.team}" not found` };
  if (callerId !== 'root' && team.parentId !== callerId)
    return { success: false, error: 'caller is not parent of target team' };

  // Compute target scope in memory before any DB mutations
  const current = new Set(deps.orgTree.getOwnScope(data.team));
  const target = new Set(current);

  if (data.scope_add) {
    for (const kw of data.scope_add) target.add(kw.toLowerCase().trim());
  }
  if (data.scope_remove) {
    for (const kw of data.scope_remove) target.delete(kw.toLowerCase().trim());
  }

  if (target.size === 0) {
    return { success: false, error: 'update would leave team with zero scope keywords' };
  }

  // Apply only the true delta
  const toAdd = [...target].filter(kw => !current.has(kw));
  const toRemove = [...current].filter(kw => !target.has(kw));

  if (toAdd.length > 0) deps.orgTree.addScopeKeywords(data.team, toAdd);
  for (const kw of toRemove) deps.orgTree.removeScopeKeyword(data.team, kw);

  deps.log('Updated team scope', { team: data.team, added: toAdd, removed: toRemove });
  return { success: true, scope: [...target].sort() };
}
