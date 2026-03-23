/**
 * spawn_team tool — creates a new team in the org tree and spawns its session.
 *
 * Input: {name: string, config_path?: string}
 * Validates config, registers team in OrgTree, calls ISessionSpawner.
 */

import { z } from 'zod';
import type { OrgTree } from '../../domain/org-tree.js';
import type { ISessionSpawner } from '../../domain/interfaces.js';
import { TeamStatus } from '../../domain/types.js';
import type { TeamConfig } from '../../domain/types.js';

export const SpawnTeamInputSchema = z.object({
  name: z.string().min(1),
  config_path: z.string().optional(),
});

export type SpawnTeamInput = z.infer<typeof SpawnTeamInputSchema>;

export interface SpawnTeamResult {
  readonly success: boolean;
  readonly team?: string;
  readonly error?: string;
}

export interface SpawnTeamDeps {
  readonly orgTree: OrgTree;
  readonly spawner: ISessionSpawner;
  readonly loadConfig: (name: string, configPath?: string) => TeamConfig;
}

export async function spawnTeam(
  input: SpawnTeamInput,
  callerId: string,
  deps: SpawnTeamDeps,
): Promise<SpawnTeamResult> {
  const parsed = SpawnTeamInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: `invalid input: ${parsed.error.message}` };
  }

  const { name, config_path } = parsed.data;

  // Check if team already exists
  const existing = deps.orgTree.getTeam(name);
  if (existing) {
    return { success: false, error: `team "${name}" already exists` };
  }

  // Load and validate config
  let config: TeamConfig;
  try {
    config = deps.loadConfig(name, config_path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `config error: ${msg}` };
  }

  // Register in org tree with caller as parent
  deps.orgTree.addTeam({
    teamId: name,
    name: config.name,
    parentId: callerId,
    status: TeamStatus.Active,
    agents: [],
    children: [],
  });

  // Spawn the session
  try {
    await deps.spawner.spawn(name, name);
  } catch (err) {
    // Roll back org tree entry on spawn failure
    deps.orgTree.removeTeam(name);
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `spawn failed: ${msg}` };
  }

  return { success: true, team: name };
}
