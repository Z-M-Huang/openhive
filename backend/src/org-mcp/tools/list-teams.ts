/**
 * list_teams tool — returns caller's child teams with descriptions, scope, and status.
 *
 * Provides the LLM with all information needed to make routing decisions:
 * team name, description, own scope keywords, queue depth, and hierarchy.
 * Replaces the deleted checkScopeAdmission keyword matcher.
 */

import { z } from 'zod';
import type { OrgTree } from '../../domain/org-tree.js';
import type { ITaskQueueStore } from '../../domain/interfaces.js';
import type { TeamConfig } from '../../domain/types.js';
import { TaskStatus } from '../../domain/types.js';

/** Max recursion depth to prevent runaway traversal on deep/cyclic trees. */
const MAX_DEPTH = 10;

export const ListTeamsInputSchema = z.object({
  recursive: z.boolean().default(false),
});

export type ListTeamsInput = z.infer<typeof ListTeamsInputSchema>;

export interface TeamInfo {
  readonly teamId: string;
  readonly name: string;
  readonly description: string;
  readonly keywords: string[];
  readonly status: string;
  readonly pendingCount: number;
  readonly children?: TeamInfo[];
}

export interface ListTeamsResult {
  readonly success: boolean;
  readonly teams?: TeamInfo[];
  readonly error?: string;
}

export interface ListTeamsDeps {
  readonly orgTree: OrgTree;
  readonly taskQueue: ITaskQueueStore;
  readonly getTeamConfig: (teamId: string) => TeamConfig | undefined;
}

export function listTeams(
  input: ListTeamsInput,
  callerId: string,
  deps: ListTeamsDeps,
): ListTeamsResult {
  const parsed = ListTeamsInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: `invalid input: ${parsed.error.message}` };
  }

  const children = deps.orgTree.getChildren(callerId);
  const visited = new Set<string>([callerId]);
  const teams = children.map((child) =>
    buildTeamInfo(child.teamId, deps, parsed.data.recursive, visited, 0),
  );

  return { success: true, teams };
}

function buildTeamInfo(
  teamId: string, deps: ListTeamsDeps, recursive: boolean,
  visited: Set<string>, depth: number,
): TeamInfo {
  visited.add(teamId);
  const team = deps.orgTree.getTeam(teamId);
  const config = deps.getTeamConfig(teamId);
  const tasks = deps.taskQueue.getByTeam(teamId);
  // Own keywords only — NOT effective scope. LLM sees the tree structure
  // and can infer routing reach from children's keywords.
  const ownKeywords = deps.orgTree.getOwnScope(teamId);

  const info: TeamInfo = {
    teamId,
    name: team?.name ?? teamId,
    description: config?.description ?? '',
    keywords: ownKeywords,
    status: team?.status ?? 'unknown',
    pendingCount: tasks.filter((t) => t.status === TaskStatus.Pending).length,
  };

  if (recursive && depth < MAX_DEPTH) {
    const children = deps.orgTree.getChildren(teamId)
      .filter((c) => !visited.has(c.teamId));
    if (children.length > 0) {
      return {
        ...info,
        children: children.map((c) =>
          buildTeamInfo(c.teamId, deps, true, visited, depth + 1),
        ),
      };
    }
  }

  return info;
}
