/**
 * list_completed_tasks tool — returns recent terminal-state tasks for a team.
 *
 * Input: {team?: string, since?: string, limit?: number}
 * Queries task_queue for done/failed tasks, returns truncated result snippets.
 */

import { z } from 'zod';
import type { ITaskQueueStore } from '../../domain/interfaces.js';
import { TaskStatus } from '../../domain/types.js';

export const ListCompletedTasksInputSchema = z.object({
  team: z.string().optional().describe('Team to query (default: caller team)'),
  since: z.string().optional().describe('ISO date to filter from (default: 7 days ago)'),
  limit: z.number().int().min(1).max(200).optional().describe('Max results (default: 50)'),
});

export type ListCompletedTasksInput = z.infer<typeof ListCompletedTasksInputSchema>;

export interface CompletedTaskSummary {
  readonly id: string;
  readonly status: string;
  readonly durationMs: number | null;
  readonly resultSnippet: string | null;
  readonly createdAt: string;
}

export interface ListCompletedTasksResult {
  readonly success: boolean;
  readonly tasks?: CompletedTaskSummary[];
  readonly error?: string;
}

export interface ListCompletedTasksDeps {
  readonly taskQueue: ITaskQueueStore;
}

export function listCompletedTasks(
  input: ListCompletedTasksInput,
  callerId: string,
  deps: ListCompletedTasksDeps,
): ListCompletedTasksResult {
  const parsed = ListCompletedTasksInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: `invalid input: ${parsed.error.message}` };
  }

  const team = parsed.data.team ?? callerId;
  const limit = parsed.data.limit ?? 50;
  const since = parsed.data.since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const allTasks = deps.taskQueue.getByTeam(team);

  const terminal = allTasks
    .filter((t) =>
      (t.status === TaskStatus.Done || t.status === TaskStatus.Failed || t.status === TaskStatus.Cancelled) &&
      t.createdAt >= since,
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);

  const tasks: CompletedTaskSummary[] = terminal.map((t) => ({
    id: t.id,
    status: t.status,
    durationMs: t.durationMs ?? null,
    resultSnippet: t.result ? t.result.slice(0, 200) : null,
    createdAt: t.createdAt,
  }));

  return { success: true, tasks };
}
