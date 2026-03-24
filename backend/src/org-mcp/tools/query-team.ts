/**
 * query_team tool — synchronously queries a child team and returns its response.
 *
 * Unlike delegate_task (fire-and-forget), this blocks until the child team's
 * SDK session completes and returns the response text to the caller.
 *
 * Input: { team: string, query: string }
 * Validates caller is parent. Runs scope admission. Calls handleMessage() blocking.
 */

import { z } from 'zod';
import type { OrgTree } from '../../domain/org-tree.js';
import type { TeamConfig } from '../../domain/types.js';
import type { MessageHandlerDeps } from '../../sessions/message-handler.js';
import { checkScopeAdmission } from '../scope-admission.js';

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
  readonly getHandlerDeps?: () => MessageHandlerDeps | null;
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

  // Run scope admission check
  const config = deps.getTeamConfig(team);
  if (config) {
    const admission = checkScopeAdmission(query, config.scope);
    if (!admission.admitted) {
      return { success: false, error: admission.reason };
    }
  }

  // Get handler deps via lazy getter (breaks circular dep)
  const getHandlerDeps = deps.getHandlerDeps;
  if (!getHandlerDeps) {
    return { success: false, error: 'query_team not configured: no handler deps getter' };
  }
  const handlerDeps = getHandlerDeps();
  if (!handlerDeps) {
    return { success: false, error: 'query_team not available: providers not configured' };
  }

  // Set stream-close timeout for long-running child sessions (SDK default is 60s)
  process.env['CLAUDE_CODE_STREAM_CLOSE_TIMEOUT'] = '1800000';

  // Compute ancestor chain for the child team
  const ancestors = deps.orgTree.getAncestors(team).map((a) => a.name);

  deps.log('query_team: invoking handleMessage', { callerId, team, query: query.slice(0, 100) });

  try {
    // Dynamic import to avoid circular dependency at module load time
    const { handleMessage } = await import('../../sessions/message-handler.js');

    const response = await handleMessage(
      {
        channelId: `query:${callerId}:${team}:${Date.now()}`,
        userId: callerId,
        content: query,
        timestamp: Date.now(),
      },
      { ...handlerDeps, orgAncestors: ancestors },
      undefined, // queryFn — use default SDK
      team,
    );

    if (!response) {
      return { success: false, error: 'Team returned empty response' };
    }

    // handleMessage returns error strings like "Error processing message: ..."
    // instead of throwing — detect and propagate as failures
    if (response.startsWith('Error processing message:') || response.startsWith('OpenHive is not configured')) {
      return { success: false, error: response };
    }

    return { success: true, response };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.log('query_team error', { team, error: msg });
    return { success: false, error: `query_team failed: ${msg}` };
  }
}
