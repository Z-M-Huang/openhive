/**
 * spawn_team tool — creates a new team in the org tree and spawns its session.
 *
 * Input: {name, config_path?}
 * Config is loaded via deps.loadConfig which either reads an existing
 * config.yaml or generates a default. The tool then scaffolds directories,
 * writes the config to .run/teams/{name}/config.yaml, registers in the
 * org tree, and spawns the session.
 *
 * On spawn failure, both the org tree entry and scaffolded dirs are cleaned up.
 */

import { z } from 'zod';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stringify as yamlStringify } from 'yaml';
import type { OrgTree } from '../../domain/org-tree.js';
import type { ISessionSpawner } from '../../domain/interfaces.js';
import { TeamStatus } from '../../domain/types.js';
import type { TeamConfig } from '../../domain/types.js';

/** Team names must be lowercase slugs to prevent path traversal. */
const TEAM_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const SpawnTeamInputSchema = z.object({
  name: z.string().min(1).regex(TEAM_SLUG_RE, 'team name must be a lowercase slug (a-z0-9 and hyphens)'),
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
  readonly runDir: string;
  readonly loadConfig: (name: string, configPath?: string) => TeamConfig;
}

/** Subdirectories to scaffold for each new team. */
const TEAM_SUBDIRS = [
  'workspace', 'memory', 'org-rules', 'team-rules', 'skills', 'subagents',
] as const;

/** Scaffold the team directory structure under .run/teams/{name}/. */
function scaffoldTeamDirs(runDir: string, teamName: string): void {
  const teamDir = join(runDir, 'teams', teamName);
  for (const sub of TEAM_SUBDIRS) {
    mkdirSync(join(teamDir, sub), { recursive: true });
  }
}

/** Remove scaffolded team dirs (best-effort cleanup on failure). */
function cleanupTeamDirs(runDir: string, teamName: string): void {
  const teamDir = join(runDir, 'teams', teamName);
  if (existsSync(teamDir)) {
    rmSync(teamDir, { recursive: true, force: true });
  }
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
  if (deps.orgTree.getTeam(name)) {
    return { success: false, error: `team "${name}" already exists` };
  }

  // Verify the resolved path stays within .run/teams/ (defense in depth)
  const teamsBase = resolve(deps.runDir, 'teams');
  const teamDir = resolve(teamsBase, name);
  if (!teamDir.startsWith(teamsBase + '/')) {
    return { success: false, error: 'path traversal detected in team name' };
  }

  // Load config — loadConfig either reads from config_path or generates one.
  // For fresh spawns without config_path, bootstrap's loadConfig will throw
  // (no file on disk yet). The calling agent must provide config_path.
  let config: TeamConfig;
  try {
    config = deps.loadConfig(name, config_path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `config error: ${msg}` };
  }

  // Scaffold directories and write config
  try {
    scaffoldTeamDirs(deps.runDir, name);
    const cfgPath = join(deps.runDir, 'teams', name, 'config.yaml');
    writeFileSync(cfgPath, yamlStringify(config), 'utf-8');
  } catch (err) {
    cleanupTeamDirs(deps.runDir, name);
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `scaffold error: ${msg}` };
  }

  // Register in org tree — use name as both teamId and name for consistency.
  // Recovery looks up config by team.name, so teamId === name avoids drift.
  deps.orgTree.addTeam({
    teamId: name,
    name,
    parentId: callerId,
    status: TeamStatus.Active,
    agents: [],
    children: [],
  });

  // Spawn the session
  try {
    await deps.spawner.spawn(name, name);
  } catch (err) {
    // Roll back: org tree entry + scaffolded directories
    deps.orgTree.removeTeam(name);
    cleanupTeamDirs(deps.runDir, name);
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `spawn failed: ${msg}` };
  }

  return { success: true, team: name };
}
