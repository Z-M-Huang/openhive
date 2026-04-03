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

/**
 * Build the session context (cwd, additionalDirectories).
 *
 * CWD is the team directory itself (teams/{name}/), so agents can
 * naturally access memory/, skills/, etc. without path hacks.
 *
 * @param teamName  Team slug.
 * @param runDir    Absolute path to the runtime workspace root (.run/).
 */
export function buildSessionContext(
  teamName: string,
  runDir: string,
): SessionContext {
  const cwd = join(runDir, 'teams', teamName);
  return { cwd, additionalDirectories: [] };
}
