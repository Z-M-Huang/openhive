/**
 * Subagent name validator.
 *
 * Shared by create_trigger and update_trigger handlers. Verifies that a
 * subagent name resolves to a known definition under the team's
 * `subagents/` directory before the trigger is persisted. Unknown names
 * are rejected so triggers cannot silently reference missing subagents.
 */

import type { SubagentDefinition } from '../../sessions/skill-loader.js';

export type LoadSubagentsFn = (runDir: string, team: string) => Record<string, SubagentDefinition>;

export interface ValidateSubagentResult {
  readonly ok: boolean;
  readonly error?: string;
}

/**
 * Validate that a subagent name (when provided) matches a known subagent
 * for the given team.
 *
 * Returns `{ ok: true }` when:
 *   - `subagent` is `undefined` — the field is optional.
 *   - `subagent` matches a name under `runDir/teams/<team>/subagents/`.
 *
 * Returns `{ ok: false, error }` with a concrete message when the name
 * does not match any defined subagent.
 */
export function validateSubagent(
  subagent: string | undefined,
  team: string,
  runDir: string,
  loadSubagents: LoadSubagentsFn,
): ValidateSubagentResult {
  if (subagent === undefined) return { ok: true };

  const known = loadSubagents(runDir, team);
  if (known[subagent]) return { ok: true };

  const available = Object.keys(known);
  const hint = available.length > 0
    ? ` (available: ${available.join(', ')})`
    : ' (no subagents defined for this team)';
  return {
    ok: false,
    error: `Unknown subagent "${subagent}" for team "${team}"${hint}`,
  };
}
