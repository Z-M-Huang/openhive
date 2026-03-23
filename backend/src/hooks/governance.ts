/**
 * Governance PreToolUse hook (self-evolution authorization).
 *
 * Controls which rule/skill/config files an agent may write to,
 * based on team ownership. Global rules and other teams' directories
 * are always blocked.
 */

import { resolve } from 'node:path';

import type { PreToolUseHook } from './workspace-boundary.js';

/** Classification of a target file for governance purposes. */
type FileClass =
  | 'global-rules'
  | 'main-org-rules'
  | 'other-team'
  | 'own-org-rules'
  | 'own-team-rules'
  | 'own-skills'
  | 'own-subagents'
  | 'own-memory'
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
  for (const [prefix, cls] of OWN_TEAM_PREFIXES) {
    if (subPath.startsWith(prefix + '/') || subPath === prefix) {
      return cls;
    }
  }
  return 'other';
}

/** Determine the governance class of a resolved absolute path. */
function classifyPath(
  resolved: string,
  teamName: string,
  dataDir: string,
): FileClass {
  const rel = resolved.startsWith(dataDir + '/')
    ? resolved.slice(dataDir.length + 1)
    : undefined;

  if (rel === undefined) {
    return 'other';
  }

  if (rel.startsWith('rules/global/') || rel === 'rules/global') {
    return 'global-rules';
  }

  if (rel.startsWith('main/org-rules/') || rel === 'main/org-rules') {
    return 'main-org-rules';
  }

  if (!rel.startsWith('teams/')) {
    return 'other';
  }

  const afterTeams = rel.slice('teams/'.length);
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
 * @param dataDir   Absolute path to the data directory.
 * @param logger    Logger with info method.
 */
export function createGovernanceHook(
  teamName: string,
  dataDir: string,
  logger: { info: (msg: string, meta?: Record<string, unknown>) => void },
): PreToolUseHook {
  return (input) => {
    const filePath = typeof input.tool_input['file_path'] === 'string'
      ? input.tool_input['file_path']
      : undefined;

    if (filePath === undefined) {
      return Promise.resolve({});
    }

    const resolved = resolve(filePath);
    const cls = classifyPath(resolved, teamName, dataDir);

    switch (cls) {
      case 'global-rules':
      case 'main-org-rules':
      case 'other-team':
        return Promise.resolve({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
              `Governance: ${input.tool_name} blocked for ${cls} path: ${resolved}`,
          },
        });

      case 'own-org-rules':
      case 'own-team-rules':
      case 'own-skills':
      case 'own-subagents':
        logger.info('Governance: self-evolution write', {
          team: teamName,
          tool: input.tool_name,
          fileClass: cls,
          path: resolved,
        });
        return Promise.resolve({});

      case 'own-memory':
      case 'other':
        return Promise.resolve({});
    }
  };
}
