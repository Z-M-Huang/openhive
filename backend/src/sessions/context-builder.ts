/**
 * Session context builder — assembles cwd and additionalDirectories
 * for an SDK query() call.
 *
 * All team directories live under {runDir}/teams/{teamName}/.
 * No secrets are passed through context — API keys come from
 * provider-resolver and are injected as env vars directly.
 */

import { join } from 'node:path';

export interface SessionContext {
  readonly cwd: string;
  readonly additionalDirectories: string[];
}

/** Subdirectories under teams/{name}/ that agents may access. */
const ADDITIONAL_SUBDIRS = [
  'memory',
  'org-rules',
  'team-rules',
  'skills',
  'subagents',
] as const;

/**
 * Build the session context (cwd, additionalDirectories).
 *
 * @param teamName  Team slug.
 * @param runDir    Absolute path to the runtime workspace root (.run/).
 */
export function buildSessionContext(
  teamName: string,
  runDir: string,
): SessionContext {
  const teamDir = join(runDir, 'teams', teamName);
  const cwd = join(teamDir, 'workspace');

  const additionalDirectories = ADDITIONAL_SUBDIRS.map(
    (sub) => join(teamDir, sub),
  );

  return { cwd, additionalDirectories };
}
