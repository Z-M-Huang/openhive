/**
 * query_team tool — synchronously queries a child team and returns its response.
 *
 * Unlike delegate_task (fire-and-forget), this blocks until the child team's
 * SDK session completes and returns the response text to the caller.
 *
 * Input: { team: string, query: string }
 * Validates caller is parent. Runs scope admission. Calls queryRunner blocking.
 */

import { z } from 'zod';
import type { OrgTree } from '../../domain/org-tree.js';
import type { TeamConfig } from '../../domain/types.js';
import type { TeamQueryRunner } from '../registry.js';
import { checkScopeAdmission } from '../scope-admission.js';
import { scrubSecrets } from '../../logging/credential-scrubber.js';

export const QueryTeamInputSchema = z.object({
  team: z.string().min(1),
  query: z.string().min(1),
});

export type QueryTeamInput = z.infer<typeof QueryTeamInputSchema>;

export interface QueryTeamResult {
  readonly success: boolean;
  readonly response?: string;
  readonly error?: string;
}

export interface QueryTeamDeps {
  readonly orgTree: OrgTree;
  readonly getTeamConfig: (teamId: string) => TeamConfig | undefined;
  readonly queryRunner?: TeamQueryRunner;
  readonly log: (msg: string, meta?: Record<string, unknown>) => void;
}

export async function queryTeam(
  input: QueryTeamInput,
  callerId: string,
  deps: QueryTeamDeps,
): Promise<QueryTeamResult> {
  const parsed = QueryTeamInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: `invalid input: ${parsed.error.message}` };
  }

  const { team, query } = parsed.data;

  // Validate target team exists
  const targetTeam = deps.orgTree.getTeam(team);
  if (!targetTeam) {
    return { success: false, error: `team "${team}" not found` };
  }

  // Validate caller is parent of target team
  if (targetTeam.parentId !== callerId) {
    return { success: false, error: 'caller is not parent of target team' };
  }

  // Run scope admission check (fail-closed: reject if config not loadable)
  const config = deps.getTeamConfig(team);
  if (!config) {
    deps.log(`scope check failed: config not loadable for team "${team}"`);
    return { success: false, error: `config not loadable for team "${team}" — cannot verify scope` };
  }
  const admission = checkScopeAdmission(query, config.scope);
  if (!admission.admitted) {
    return { success: false, error: admission.reason };
  }

  // Check queryRunner is available
  if (!deps.queryRunner) {
    return { success: false, error: 'query_team not available: providers not configured' };
  }

  // Compute ancestor chain for the child team
  const ancestors = deps.orgTree.getAncestors(team).map((a) => a.name);

  deps.log('query_team: invoking queryRunner', { callerId, team, query: query.slice(0, 100) });

  try {
    const response = await deps.queryRunner(query, team, callerId, ancestors);

    if (!response) {
      return { success: false, error: 'Team returned empty response' };
    }

    // handleMessage returns error strings like "Error processing message: ..."
    // instead of throwing — detect and propagate as failures
    if (response.startsWith('Error processing message:') || response.startsWith('OpenHive is not configured')) {
      return { success: false, error: response };
    }

    // Scrub child team credential values from response
    const childCreds = config.credentials ?? {};
    const childCredValues = Object.values(childCreds).filter(
      (v): v is string => typeof v === 'string' && v.length >= 8,
    );
    const scrubbedResponse = childCredValues.length > 0
      ? scrubSecrets(response, [], childCredValues) : response;

    return { success: true, response: scrubbedResponse };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.log('query_team error', { team, error: msg });
    return { success: false, error: `query_team failed: ${msg}` };
  }
}
