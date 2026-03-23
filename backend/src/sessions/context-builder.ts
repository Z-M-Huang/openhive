/**
 * Session context builder — assembles env, cwd, and additionalDirectories
 * for an SDK query() call.
 *
 * Pure data assembly, no side effects.
 */

import { join } from 'node:path';
import type { SecretString } from '../secrets/secret-string.js';

export interface SessionContext {
  readonly env: Record<string, string>;
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
 * Build the session context (env, cwd, additionalDirectories).
 *
 * @param teamName    Team slug.
 * @param dataDir     Absolute path to the data root directory.
 * @param secrets     Resolved secrets map for the team.
 * @param secretRefs  Keys to include from the secrets map. Only these secrets
 *                    are exposed in the session env.
 */
export function buildSessionContext(
  teamName: string,
  dataDir: string,
  secrets: Map<string, SecretString>,
  secretRefs?: readonly string[],
): SessionContext {
  const env: Record<string, string> = {};
  for (const [key, secret] of secrets) {
    if (secretRefs && !secretRefs.includes(key)) continue;
    env[key] = secret.expose();
  }

  const teamDir = join(dataDir, 'teams', teamName);
  const cwd = join(teamDir, 'workspace');

  const additionalDirectories = ADDITIONAL_SUBDIRS.map(
    (sub) => join(teamDir, sub),
  );

  return { env, cwd, additionalDirectories };
}
