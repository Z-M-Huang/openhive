/**
 * Task consumer — processes pending tasks for child teams.
 *
 * Polls the task queue and spawns SDK sessions for pending tasks.
 * Runs as a background loop started by bootstrap.
 */

import type { ITaskQueueStore } from '../domain/interfaces.js';
import type { OrgTree } from '../domain/org-tree.js';
import type { TeamConfig } from '../domain/types.js';
import { TaskStatus } from '../domain/types.js';
import { handleMessage } from './message-handler.js';
import type { MessageHandlerDeps } from './message-handler.js';
import type { QueryFn } from './spawner.js';
import { scrubSecrets } from '../logging/credential-scrubber.js';

export interface TaskConsumerOpts {
  readonly taskQueueStore: ITaskQueueStore;
  readonly orgTree: OrgTree;
  readonly handlerDeps: MessageHandlerDeps;
  readonly pollIntervalMs?: number;
  readonly queryFn?: QueryFn;
  readonly notifyChannel?: (content: string) => Promise<void>;
  readonly getTeamConfig?: (teamId: string) => TeamConfig | undefined;
  readonly syncTeamTriggers?: (teamId: string) => void;
}

export class TaskConsumer {
  readonly #taskQueue: ITaskQueueStore;
  readonly #orgTree: OrgTree;
  readonly #deps: MessageHandlerDeps;
  readonly #pollMs: number;
  readonly #queryFn?: QueryFn;
  readonly #notifyChannel?: (content: string) => Promise<void>;
  readonly #getTeamConfig?: (teamId: string) => TeamConfig | undefined;
  readonly #syncTeamTriggers?: (teamId: string) => void;
  #timer: ReturnType<typeof setInterval> | null = null;
  #processing = false;

  constructor(opts: TaskConsumerOpts) {
    this.#taskQueue = opts.taskQueueStore;
    this.#orgTree = opts.orgTree;
    this.#deps = opts.handlerDeps;
    this.#pollMs = opts.pollIntervalMs ?? 5_000;
    this.#queryFn = opts.queryFn;
    this.#notifyChannel = opts.notifyChannel;
    this.#getTeamConfig = opts.getTeamConfig;
    this.#syncTeamTriggers = opts.syncTeamTriggers;
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
          // Auto-sync triggers after successful bootstrap
          if (!isError && dequeued.task.startsWith('Bootstrap this team')) {
            this.#tryAutoSyncTriggers(task.teamId);
          }
          // Scrub credentials from response — use safeResponse for ALL downstream consumers
          let safeResponse = response;
          if (response) {
            const config = this.#getTeamConfig?.(task.teamId);
            const creds = Object.values(config?.credentials ?? {}).filter(
              (v): v is string => typeof v === 'string' && v.length >= 8,
            );
            if (creds.length > 0) safeResponse = scrubSecrets(response, [], creds);
          }
          // Store scrubbed result so task outcomes are queryable
          if (safeResponse) {
            this.#taskQueue.updateResult(dequeued.id, safeResponse.slice(0, 10_000));
          }
          this.#deps.logger.info(isError ? 'Task failed (handler error)' : 'Task completed', {
            taskId: dequeued.id, team: task.teamId,
            responseLength: safeResponse?.length ?? 0,
            responseSnippet: safeResponse ? safeResponse.slice(0, 200) : null,
          });
          // Notify connected channels about task completion (scrubbed)
          if (this.#notifyChannel && safeResponse) {
            const summary = safeResponse.slice(0, 500);
            const notif = `[${task.teamId}] Task completed: ${dequeued.task.slice(0, 100)}\n\nResult: ${summary}`;
            this.#notifyChannel(notif).catch(() => {});
          }
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

  #tryAutoSyncTriggers(teamId: string): void {
    if (!this.#syncTeamTriggers) return;
    try {
      this.#syncTeamTriggers(teamId);
    } catch (err) {
      this.#deps.logger.info('Failed to auto-sync triggers after bootstrap', {
        team: teamId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  #getAncestorNames(teamId: string): string[] {
    return this.#orgTree.getAncestors(teamId).map(a => a.name);
  }
}
