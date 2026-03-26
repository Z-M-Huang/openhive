/**
 * Task consumer — processes pending tasks for child teams.
 *
 * Polls the task queue and spawns SDK sessions for pending tasks.
 * Runs as a background loop started by bootstrap.
 */

import type { ITaskQueueStore } from '../domain/interfaces.js';
import type { OrgTree } from '../domain/org-tree.js';
import { TaskStatus } from '../domain/types.js';
import { handleMessage } from './message-handler.js';
import type { MessageHandlerDeps } from './message-handler.js';
import type { QueryFn } from './spawner.js';

export interface TaskConsumerOpts {
  readonly taskQueueStore: ITaskQueueStore;
  readonly orgTree: OrgTree;
  readonly handlerDeps: MessageHandlerDeps;
  readonly pollIntervalMs?: number;
  readonly queryFn?: QueryFn;
}

export class TaskConsumer {
  readonly #taskQueue: ITaskQueueStore;
  readonly #orgTree: OrgTree;
  readonly #deps: MessageHandlerDeps;
  readonly #pollMs: number;
  readonly #queryFn?: QueryFn;
  #timer: ReturnType<typeof setInterval> | null = null;
  #processing = false;

  constructor(opts: TaskConsumerOpts) {
    this.#taskQueue = opts.taskQueueStore;
    this.#orgTree = opts.orgTree;
    this.#deps = opts.handlerDeps;
    this.#pollMs = opts.pollIntervalMs ?? 5_000;
    this.#queryFn = opts.queryFn;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.#tick(), this.#pollMs);
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  async #tick(): Promise<void> {
    if (this.#processing) return;
    this.#processing = true;

    try {
      const pending = this.#taskQueue.getPending();
      for (const task of pending) {
        // Skip main team tasks (handled by channel router directly)
        if (task.teamId === 'main') continue;

        // Dequeue and mark running
        const dequeued = this.#taskQueue.dequeue(task.teamId);
        if (!dequeued) continue;

        try {
          const response = await handleMessage(
            {
              channelId: `task:${dequeued.id}`,
              userId: 'system',
              content: dequeued.task,
              timestamp: Date.now(),
            },
            { ...this.#deps, orgAncestors: this.#getAncestorNames(task.teamId) },
            this.#queryFn,
            task.teamId,
          );

          // Detect error responses (handleMessage returns "Error: ..." on failure)
          const isError = typeof response === 'string' && response.startsWith('Error processing');
          this.#taskQueue.updateStatus(dequeued.id, isError ? TaskStatus.Failed : TaskStatus.Completed);
          // Store LLM response so task outcomes are queryable
          if (response) {
            this.#taskQueue.updateResult(dequeued.id, response.slice(0, 10_000));
          }
          this.#deps.logger.info(isError ? 'Task failed (handler error)' : 'Task completed', {
            taskId: dequeued.id, team: task.teamId,
            responseLength: response?.length ?? 0,
            responseSnippet: response ? response.slice(0, 200) : null,
          });
        } catch (err) {
          this.#taskQueue.updateStatus(dequeued.id, TaskStatus.Failed);
          const msg = err instanceof Error ? err.message : String(err);
          this.#deps.logger.info('Task failed', { taskId: dequeued.id, team: task.teamId, error: msg });
        }
      }
    } finally {
      this.#processing = false;
    }
  }

  #getAncestorNames(teamId: string): string[] {
    return this.#orgTree.getAncestors(teamId).map(a => a.name);
  }
}
