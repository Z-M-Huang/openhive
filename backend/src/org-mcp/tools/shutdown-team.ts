/**
 * shutdown_team tool — shuts down a team, persists pending tasks, removes from org tree.
 *
 * Input: {name: string}
 * Validates caller is parent. Persists pending tasks. Marks idle. Stops session. Removes from tree.
 */

import { z } from 'zod';
import type { OrgTree } from '../../domain/org-tree.js';
import type { ISessionManager, ITaskQueueStore } from '../../domain/interfaces.js';

export const ShutdownTeamInputSchema = z.object({
  name: z.string().min(1),
});

export type ShutdownTeamInput = z.infer<typeof ShutdownTeamInputSchema>;

export interface ShutdownTeamResult {
  readonly success: boolean;
  readonly error?: string;
}

export interface ShutdownTeamDeps {
  readonly orgTree: OrgTree;
  readonly sessionManager: ISessionManager;
  readonly taskQueue: ITaskQueueStore;
}

export async function shutdownTeam(
  input: ShutdownTeamInput,
  callerId: string,
  deps: ShutdownTeamDeps,
): Promise<ShutdownTeamResult> {
  const parsed = ShutdownTeamInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: `invalid input: ${parsed.error.message}` };
  }

  const { name } = parsed.data;

  // Validate team exists
  const team = deps.orgTree.getTeam(name);
  if (!team) {
    return { success: false, error: `team "${name}" not found` };
  }

  // Validate caller is parent
  if (team.parentId !== callerId) {
    return { success: false, error: 'caller is not parent of target team' };
  }

  // Pending tasks are already persisted in SQLite via TaskQueueStore.
  // No additional persistence step needed; they remain in the task_queue table.

  // Stop session
  await deps.sessionManager.terminateSession(name);

  // Remove from org tree
  deps.orgTree.removeTeam(name);

  return { success: true };
}
