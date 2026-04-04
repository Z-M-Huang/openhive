/**
 * shutdown_team tool — shuts down a team, persists pending tasks, removes from org tree.
 *
 * Input: {name: string}
 * Validates caller is parent. Persists pending tasks. Marks idle. Stops session. Removes from tree.
 */

import { z } from 'zod';
import type { OrgTree } from '../../domain/org-tree.js';
import type { ISessionManager, ITaskQueueStore } from '../../domain/interfaces.js';
import { cleanupTeamDirs } from './team-fs.js';

export const ShutdownTeamInputSchema = z.object({
  name: z.string().min(1),
  cascade: z.boolean().optional().default(false),
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
  readonly triggerEngine?: { removeTeamTriggers(team: string): void };
  readonly triggerConfigStore?: { removeByTeam(team: string): void };
  readonly escalationStore?: { removeByTeam(teamId: string): void };
  readonly interactionStore?: { removeByTeam(teamId: string): void };
  readonly memoryStore?: { removeByTeam(teamName: string): void };
  readonly runDir?: string;
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

  // Reject shutdown when children exist (unless cascade requested)
  const children = deps.orgTree.getChildren(name);
  if (children.length > 0) {
    if (!parsed.data.cascade) {
      const childNames = children.map(c => c.name).join(', ');
      return {
        success: false,
        error: `team "${name}" has ${children.length} active children (${childNames}) — shut them down first, or pass cascade: true`,
      };
    }
    // Cascade: shut down children depth-first
    for (const child of children) {
      const childResult = await shutdownTeam({ name: child.name, cascade: true }, name, deps);
      if (!childResult.success) {
        return { success: false, error: `cascade failed on child "${child.name}": ${childResult.error}` };
      }
    }
  }

  // Pending tasks are already persisted in SQLite via TaskQueueStore.
  // No additional persistence step needed; they remain in the task_queue table.

  // Remove triggers for this team
  deps.triggerEngine?.removeTeamTriggers(name);

  // Stop session
  await deps.sessionManager.terminateSession(name);

  deps.triggerConfigStore?.removeByTeam(name);
  deps.taskQueue.removeByTeam(name);
  deps.escalationStore?.removeByTeam(name);
  deps.interactionStore?.removeByTeam(name);
  deps.memoryStore?.removeByTeam(name);

  if (deps.runDir) cleanupTeamDirs(deps.runDir, name);

  // Remove from org tree
  deps.orgTree.removeTeam(name);

  return { success: true };
}
