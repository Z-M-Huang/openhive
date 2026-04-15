/**
 * query_team tool — synchronously queries a child team and returns its response.
 *
 * Unlike delegate_task (fire-and-forget), this blocks until the child team's
 * SDK session completes and returns the response text to the caller.
 *
 * Input: { team: string, query: string }
 * Validates caller is parent. Calls queryRunner blocking.
 */

import { z } from 'zod';
import type { OrgTree } from '../../domain/org-tree.js';
import type { TeamConfig } from '../../domain/types.js';
import type { TeamQueryRunner } from '../../sessions/tools/org-tool-context.js';
import type { IVaultStore } from '../../domain/interfaces.js';
import { scrubSecrets } from '../../logging/credential-scrubber.js';
import { errorMessage } from '../../domain/errors.js';

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
  readonly vaultStore?: IVaultStore;
  readonly queryRunner?: TeamQueryRunner;
  readonly log: (msg: string, meta?: Record<string, unknown>) => void;
}

export async function queryTeam(
  input: QueryTeamInput,
  callerId: string,
  deps: QueryTeamDeps,
  sourceChannelId?: string,
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

  // Check queryRunner is available
  if (!deps.queryRunner) {
    return { success: false, error: 'query_team not available: providers not configured' };
  }

  // Compute ancestor chain for the child team
  const ancestors = deps.orgTree.getAncestors(team).map((a) => a.name);

  deps.log('query_team: invoking queryRunner', { callerId, team, query: query.slice(0, 100) });

  try {
    const response = await deps.queryRunner(query, team, callerId, ancestors, sourceChannelId);

    if (!response) {
      return { success: false, error: 'Team returned empty response' };
    }

    // Scrub child team credential values from response using vault secrets (AC-10)
    const vaultSecrets = deps.vaultStore?.getSecrets(team) ?? [];
    const childCredValues = vaultSecrets.map((e) => e.value).filter((v) => v.length >= 8);
    const scrubbedResponse = childCredValues.length > 0
      ? scrubSecrets(response, [], childCredValues) : response;

    return { success: true, response: scrubbedResponse };
  } catch (err) {
    const msg = errorMessage(err);
    deps.log('query_team error', { team, error: msg });
    return { success: false, error: `query_team failed: ${msg}` };
  }
}
