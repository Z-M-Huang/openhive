/**
 * sync_team_triggers tool — read and activate triggers from a child team's triggers.yaml.
 *
 * Input: {team: string}
 * Validates caller is parent. Loads per-team triggers.yaml. Hot-registers in engine.
 */

import { z } from 'zod';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { OrgTree } from '../../domain/org-tree.js';
import type { TriggerEngine } from '../../triggers/engine.js';
import { loadTeamTriggers } from '../../config/loader.js';
import type { TriggerConfig } from '../../domain/types.js';

export const SyncTeamTriggersInputSchema = z.object({
  team: z.string().min(1),
});

export interface SyncTeamTriggersResult {
  readonly success: boolean;
  readonly registered?: number;
  readonly error?: string;
}

export interface SyncTeamTriggersDeps {
  readonly orgTree: OrgTree;
  readonly triggerEngine: TriggerEngine;
  readonly runDir: string;
  readonly log: (msg: string, meta?: Record<string, unknown>) => void;
}

export function syncTeamTriggers(
  input: z.infer<typeof SyncTeamTriggersInputSchema>,
  callerId: string,
  deps: SyncTeamTriggersDeps,
): SyncTeamTriggersResult {
  const team = deps.orgTree.getTeam(input.team);
  if (!team) return { success: false, error: `team "${input.team}" not found` };

  if (team.parentId !== callerId)
    return { success: false, error: 'caller is not parent of target team' };

  const path = join(deps.runDir, 'teams', input.team, 'triggers.yaml');
  if (!existsSync(path)) {
    deps.triggerEngine.removeTeamTriggers(input.team);
    deps.log('Removed triggers (no file)', { team: input.team });
    return { success: true, registered: 0 };
  }

  let parsed;
  try { parsed = loadTeamTriggers(path); }
  catch (err) {
    return { success: false, error: `invalid triggers.yaml: ${err instanceof Error ? err.message : String(err)}` };
  }

  const configs: TriggerConfig[] = parsed.triggers.map(t => ({ ...t, team: input.team }));

  deps.triggerEngine.replaceTeamTriggers(input.team, configs);
  deps.log('Synced team triggers', { team: input.team, count: configs.length });

  return { success: true, registered: configs.length };
}
