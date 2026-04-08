/**
 * spawn_team tool — creates a new team in the org tree and spawns its session.
 *
 * Input: {name, config_path?, description?, scope_accepts?,
 *         init_context?, credentials?}
 *
 * Config is loaded via deps.loadConfig which either reads an existing
 * config.yaml or generates a default. The tool then scaffolds directories,
 * writes the config to .run/teams/{name}/config.yaml, optionally writes
 * credentials and init context to memory/, registers in the org tree,
 * spawns the session, and auto-queues an initialization task.
 *
 * On any failure, all artifacts (dirs, org tree, session) are cleaned up.
 */

import { z } from 'zod';
import { mkdirSync, writeFileSync, existsSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stringify as yamlStringify } from 'yaml';
import type { OrgTree } from '../../domain/org-tree.js';
import type { ISessionSpawner, ITaskQueueStore, ITriggerConfigStore } from '../../domain/interfaces.js';
import { TeamStatus } from '../../domain/types.js';
import type { TeamConfig } from '../../domain/types.js';
import { scrubSecrets } from '../../logging/credential-scrubber.js';
import { errorMessage } from '../../domain/errors.js';
import { extractStringCredentials } from '../../domain/credential-utils.js';
import { cleanupTeamDirs } from './team-fs.js';

/** Team names must be lowercase slugs to prevent path traversal. */
const TEAM_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const SpawnTeamInputSchema = z.object({
  name: z.string().min(1).regex(TEAM_SLUG_RE, 'team name must be a lowercase slug (a-z0-9 and hyphens)'),
  config_path: z.string().optional(),
  description: z.string().optional(),
  scope_accepts: z.array(z.string().trim().min(1)).optional(),
  init_context: z.string().optional(),
  credentials: z.record(z.string(), z.string()).optional(),
}).refine(
  (data) => data.config_path || (data.scope_accepts && data.scope_accepts.length > 0),
  { message: 'scope_accepts with at least one keyword is required when config_path is not provided', path: ['scope_accepts'] },
);

export type SpawnTeamInput = z.infer<typeof SpawnTeamInputSchema>;

export interface SpawnTeamResult {
  readonly success: boolean;
  readonly team?: string;
  readonly error?: string;
  readonly note?: string;
}

export interface SpawnTeamConfigHints {
  readonly description?: string;
  readonly scopeAccepts?: string[];
  readonly parent?: string;
}

export interface SpawnTeamDeps {
  readonly orgTree: OrgTree;
  readonly spawner: ISessionSpawner;
  readonly runDir: string;
  readonly loadConfig: (name: string, configPath?: string, hints?: SpawnTeamConfigHints) => TeamConfig;
  readonly taskQueue?: ITaskQueueStore;
  readonly vaultStore?: {
    set(teamName: string, key: string, value: string, isSecret: boolean, updatedBy?: string): unknown;
    removeByTeam(teamName: string): void;
  };
  readonly triggerConfigStore?: ITriggerConfigStore;
}

/** Subdirectories to scaffold for each new team. */
const TEAM_SUBDIRS = [
  'org-rules', 'team-rules', 'skills', 'subagents',
] as const;

/** Scaffold the team directory structure under .run/teams/{name}/. */
function scaffoldTeamDirs(runDir: string, teamName: string): void {
  const teamDir = join(runDir, 'teams', teamName);
  for (const sub of TEAM_SUBDIRS) {
    mkdirSync(join(teamDir, sub), { recursive: true });
  }

  // Copy seed skills into the new team's skills/ directory
  const seedDir = join(resolve(runDir, '..'), 'seed-skills');
  if (existsSync(seedDir)) {
    cpSync(seedDir, join(teamDir, 'skills'), { recursive: true });
  }
}

export async function spawnTeam(
  input: SpawnTeamInput,
  callerId: string,
  deps: SpawnTeamDeps,
  sourceChannelId?: string,
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
  let config: TeamConfig;
  try {
    const hints: SpawnTeamConfigHints = {
      description: parsed.data.description,
      scopeAccepts: parsed.data.scope_accepts,
      parent: callerId,
    };
    config = deps.loadConfig(name, config_path, hints);
    // Ensure parent matches the actual caller, regardless of config source
    config = { ...config, parent: callerId };
  } catch (err) {
    const msg = errorMessage(err);
    return { success: false, error: `config error: ${msg}` };
  }

  // Store credentials: vault (preferred) or config.yaml (backward compat)
  const hasCredentials = parsed.data.credentials && Object.keys(parsed.data.credentials).length > 0;
  if (hasCredentials && deps.vaultStore) {
    // Write each credential to vault with is_secret=1
    for (const [key, value] of Object.entries(parsed.data.credentials!)) {
      deps.vaultStore.set(name, key, value, true, callerId);
    }
  } else if (hasCredentials) {
    // Backward compat: merge credentials into config.yaml
    config = { ...config, credentials: parsed.data.credentials };
  }

  // Scaffold directories and write config + optional memory files
  try {
    scaffoldTeamDirs(deps.runDir, name);
    const cfgPath = join(deps.runDir, 'teams', name, 'config.yaml');
    writeFileSync(cfgPath, yamlStringify(config), 'utf-8');

    // Write initialization context to team-rules/team-context.md (scrub credential values)
    if (parsed.data.init_context) {
      const initPath = join(deps.runDir, 'teams', name, 'team-rules', 'team-context.md');
      let safeContext = parsed.data.init_context;
      if (parsed.data.credentials) {
        const credValues = extractStringCredentials(parsed.data.credentials);
        if (credValues.length > 0) safeContext = scrubSecrets(safeContext, [], credValues);
      }
      writeFileSync(initPath, safeContext, 'utf-8');
    }
  } catch (err) {
    deps.vaultStore?.removeByTeam(name);
    cleanupTeamDirs(deps.runDir, name);
    const msg = errorMessage(err);
    return { success: false, error: `scaffold error: ${msg}` };
  }

  // Register in org tree
  deps.orgTree.addTeam({
    teamId: name,
    name,
    parentId: callerId,
    status: TeamStatus.Active,
    agents: [],
    children: [],
  });

  // Write scope keywords to SQLite
  if (parsed.data.scope_accepts && parsed.data.scope_accepts.length > 0) {
    deps.orgTree.addScopeKeywords(name, parsed.data.scope_accepts);
  }
  // Backward compat: if loaded from config_path with legacy scope.accepts, backfill SQLite
  if (config.scope?.accepts && config.scope.accepts.length > 0 && !parsed.data.scope_accepts) {
    deps.orgTree.addScopeKeywords(name, [...config.scope.accepts]);
  }

  // Spawn the session
  try {
    await deps.spawner.spawn(name, name);
  } catch (err) {
    deps.orgTree.removeTeam(name);
    deps.vaultStore?.removeByTeam(name);
    cleanupTeamDirs(deps.runDir, name);
    const msg = errorMessage(err);
    return { success: false, error: `spawn failed: ${msg}` };
  }

  // Auto-queue initialization task so the team self-bootstraps
  const initError = enqueueInitTask(name, parsed.data.init_context, deps, sourceChannelId);
  if (initError) return initError;

  // Seed a disabled learning-cycle trigger (skip if one already exists)
  seedLearningTrigger(name, deps.triggerConfigStore);

  return {
    success: true, team: name,
    ...(parsed.data.credentials ? { note: 'Credentials stored securely. Do NOT echo credential values.' } : {}),
  };
}

/** Build and enqueue the bootstrap initialization task. Returns error result on failure. */
function enqueueInitTask(
  name: string, initContext: string | undefined, deps: SpawnTeamDeps, sourceChannelId?: string,
): SpawnTeamResult | null {
  if (!deps.taskQueue) return null;

  const credToolName = deps.vaultStore ? 'vault_get' : 'get_credential';
  const initPayload = initContext
    ? 'Bootstrap this team. Your team context is already in your system prompt (from team-rules/team-context.md). ' +
      `Use the ${credToolName} tool to access any credentials provided during team creation. ` +
      'Steps: (1) Create skills in skills/ for your core tasks, ' +
      '(2) Use memory_save to record your identity, key decisions, and initial context, ' +
      '(3) Respond with a brief, user-friendly summary of what capabilities you now have.'
    : 'Bootstrap this team. Your description and scope are in your system prompt. ' +
      'Create initial skills in skills/ and use memory_save to record your identity. ' +
      'Respond with a summary of your capabilities.';

  try {
    deps.taskQueue.enqueue(name, initPayload, 'critical', 'bootstrap', sourceChannelId);
    return null;
  } catch (err) {
    // Roll back everything: session + org tree + vault + dirs
    try { deps.spawner.stop?.(name); } catch { /* best effort */ }
    deps.orgTree.removeTeam(name);
    deps.vaultStore?.removeByTeam(name);
    cleanupTeamDirs(deps.runDir, name);
    const msg = errorMessage(err);
    return { success: false, error: `init enqueue failed: ${msg}` };
  }
}

/** Deterministic jittered cron from team name hash: runs daily at 3:{minute}. */
export function jitteredCron(teamName: string): string {
  const hash = Buffer.from(teamName).reduce((a, b) => a + b, 0);
  const minute = hash % 60;
  return `${minute} 3 * * *`;
}

/** Create a disabled learning-cycle trigger for a team (idempotent — skips if exists). */
export function seedLearningTrigger(teamName: string, store?: ITriggerConfigStore): void {
  if (!store) return;
  const existing = store.get(teamName, 'learning-cycle');
  if (existing) return;
  store.upsert({
    name: 'learning-cycle',
    type: 'schedule',
    config: { cron: jitteredCron(teamName) },
    team: teamName,
    task: 'Run a learning cycle: review recent interactions, extract patterns, and update memory.',
    skill: 'learning-cycle',
    state: 'disabled',
  });
}
