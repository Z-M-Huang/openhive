/**
 * Governance PreToolUse hook (self-evolution authorization).
 *
 * Controls which rule/skill/config files an agent may write to,
 * based on team ownership and the three-tier data model:
 *
 * - System rules (/app/system-rules/) — BLOCK all writes (immutable)
 * - Admin org rules (/data/rules/) — BLOCK agent writes (admin-managed)
 * - Own team files (.run/teams/{name}/) — ALLOW self-evolution
 * - Other team files (.run/teams/{other}/) — BLOCK cross-team
 */

import { resolve, dirname } from 'node:path';
import { realpathSync } from 'node:fs';

import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';

/** Classification of a target file for governance purposes. */
type FileClass =
  | 'system-rules'
  | 'admin-org-rules'
  | 'other-team'
  | 'own-org-rules'
  | 'own-team-rules'
  | 'own-skills'
  | 'own-subagents'
  | 'own-memory'
  | 'own-config'
  | 'other';

/** Map of sub-path prefixes to FileClass for own-team directories. */
const OWN_TEAM_PREFIXES: ReadonlyArray<[string, FileClass]> = [
  ['org-rules', 'own-org-rules'],
  ['team-rules', 'own-team-rules'],
  ['skills', 'own-skills'],
  ['subagents', 'own-subagents'],
  ['memory', 'own-memory'],
];

/** Classify a sub-path within the owning team's directory. */
function classifyOwnTeamPath(subPath: string): FileClass {
  if (subPath === 'config.yaml') return 'own-config';
  for (const [prefix, cls] of OWN_TEAM_PREFIXES) {
    if (subPath.startsWith(prefix + '/') || subPath === prefix) {
      return cls;
    }
  }
  return 'other';
}

export interface GovernancePaths {
  readonly systemRulesDir: string;
  readonly dataDir: string;
  readonly runDir: string;
}

/** Determine the governance class of a resolved absolute path. */
function classifyPath(
  resolved: string,
  teamName: string,
  paths: GovernancePaths,
): FileClass {
  // Check system rules (immutable, baked into image)
  const sysDir = paths.systemRulesDir;
  if (resolved.startsWith(sysDir + '/') || resolved === sysDir) {
    return 'system-rules';
  }

  // Check admin org rules (/data/rules/)
  const adminRulesDir = resolve(paths.dataDir, 'rules');
  if (resolved.startsWith(adminRulesDir + '/') || resolved === adminRulesDir) {
    return 'admin-org-rules';
  }

  // Check team files under .run/teams/
  const teamsDir = resolve(paths.runDir, 'teams');
  if (!resolved.startsWith(teamsDir + '/')) {
    return 'other';
  }

  const afterTeams = resolved.slice(teamsDir.length + 1);
  const slashIdx = afterTeams.indexOf('/');
  const targetTeam = slashIdx === -1 ? afterTeams : afterTeams.slice(0, slashIdx);

  if (targetTeam !== teamName) {
    return 'other-team';
  }

  const subPath = slashIdx === -1 ? '' : afterTeams.slice(slashIdx + 1);
  return classifyOwnTeamPath(subPath);
}

/**
 * Factory: create a governance PreToolUse hook for Write/Edit tools.
 *
 * @param teamName  The team this agent belongs to.
 * @param paths     Three-tier path configuration.
 * @param logger    Logger with info method.
 */
export function createGovernanceHook(
  teamName: string,
  paths: GovernancePaths,
  logger: { info: (msg: string, meta?: Record<string, unknown>) => void },
): HookCallback {
  return (input) => {
    const { tool_name, tool_input } = input as { tool_name: string; tool_input: Record<string, unknown> };
    const filePath = typeof tool_input['file_path'] === 'string'
      ? tool_input['file_path']
      : undefined;

    if (filePath === undefined) {
      return Promise.resolve({});
    }

    // Resolve symlinks to prevent bypass (e.g. memory/link -> config.yaml)
    const resolved = resolve(filePath);
    let real: string;
    try {
      // Resolve parent dir + basename so it works even if file doesn't exist yet
      const dir = dirname(resolved);
      real = resolve(realpathSync(dir), resolved.slice(dir.length + 1));
    } catch {
      real = resolved;
    }
    const cls = classifyPath(real, teamName, paths);

    switch (cls) {
      case 'system-rules':
      case 'admin-org-rules':
      case 'other-team':
      case 'own-config':
        return Promise.resolve({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
              `Governance: ${tool_name} blocked for ${cls} path: ${real}`,
          },
        });

      case 'own-org-rules':
      case 'own-team-rules':
      case 'own-skills':
      case 'own-subagents':
        logger.info('Governance: self-evolution write', {
          team: teamName,
          tool: tool_name,
          fileClass: cls,
          path: real,
        });
        return Promise.resolve({});

      case 'own-memory':
      case 'other':
        return Promise.resolve({});
    }
  };
}
