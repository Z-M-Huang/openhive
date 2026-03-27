/**
 * Task consumer — processes pending tasks for child teams.
 *
 * Polls the task queue and spawns SDK sessions for pending tasks.
 * Reports trigger outcomes back for circuit breaker accounting.
 */

import type { ITaskQueueStore } from '../domain/interfaces.js';
import type { OrgTree } from '../domain/org-tree.js';
import type { TeamConfig } from '../domain/types.js';
import { TaskStatus } from '../domain/types.js';
import { handleMessage } from './message-handler.js';
import type { MessageHandlerDeps, MessageResult } from './message-handler.js';
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
  readonly reportTriggerOutcome?: (team: string, triggerName: string, success: boolean) => void;
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
  readonly #reportTriggerOutcome?: (team: string, triggerName: string, success: boolean) => void;
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
    this.#reportTriggerOutcome = opts.reportTriggerOutcome;
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
        if (task.teamId === 'main') continue;

        const dequeued = this.#taskQueue.dequeue(task.teamId);
        if (!dequeued) continue;

        try {
          // Replace [CREDENTIAL:xxx] placeholders with get_credential instructions
          const taskContent = dequeued.task.replace(
            /\[CREDENTIAL:(\w+)\]/g,
            (_, key: string) => `(use get_credential({ key: "${key}" }) to retrieve this value)`,
          );

          // Parse max_turns from task options (snapshot at enqueue time)
          const taskOpts = dequeued.options ? JSON.parse(dequeued.options) as Record<string, unknown> : {};
          const maxTurns = typeof taskOpts['max_turns'] === 'number' ? taskOpts['max_turns'] as number : undefined;

          const result: MessageResult = await handleMessage(
            {
              channelId: `task:${dequeued.id}`,
              userId: 'system',
              content: taskContent,
              timestamp: Date.now(),
            },
            { ...this.#deps, orgAncestors: this.#getAncestorNames(task.teamId) },
            { teamName: task.teamId, queryFn: this.#queryFn, maxTurns },
          );

          const isError = !result.ok;
          this.#taskQueue.updateStatus(dequeued.id, isError ? TaskStatus.Failed : TaskStatus.Completed);

          // Record duration
          if (this.#taskQueue.updateDuration) {
            this.#taskQueue.updateDuration(dequeued.id, result.durationMs);
          }

          // Auto-sync triggers after successful bootstrap
          if (!isError && dequeued.task.startsWith('Bootstrap this team')) {
            this.#tryAutoSyncTriggers(task.teamId);
          }

          // Report trigger outcome for circuit breaker
          const triggerMatch = dequeued.correlationId?.match(/^trigger:([^:]+):/);
          if (triggerMatch) {
            this.#reportTriggerOutcome?.(task.teamId, triggerMatch[1], !isError);
          }

          // Build safe response text
          const responseText = result.ok ? result.content : `Error: ${result.error}`;
          let safeResponse = responseText;
          if (responseText) {
            const config = this.#getTeamConfig?.(task.teamId);
            const creds = Object.values(config?.credentials ?? {}).filter(
              (v): v is string => typeof v === 'string' && v.length >= 8,
            );
            if (creds.length > 0) safeResponse = scrubSecrets(responseText, [], creds);
          }

          // Store scrubbed result (10KB cap)
          if (safeResponse) {
            this.#taskQueue.updateResult(dequeued.id, safeResponse.slice(0, 10_000));
          }

          this.#deps.logger.info(isError ? 'Task failed (handler error)' : 'Task completed', {
            taskId: dequeued.id, team: task.teamId, durationMs: result.durationMs,
            responseLength: safeResponse?.length ?? 0,
            responseSnippet: safeResponse ? safeResponse.slice(0, 200) : null,
          });

          // Notify connected channels
          if (this.#notifyChannel && safeResponse) {
            const notif = `[${task.teamId}] Task completed: ${dequeued.task}\n\nResult: ${safeResponse}`;
            this.#notifyChannel(notif).catch(() => {});
          }
        } catch (err) {
          this.#taskQueue.updateStatus(dequeued.id, TaskStatus.Failed);
          const msg = err instanceof Error ? err.message : String(err);
          this.#deps.logger.info('Task failed', { taskId: dequeued.id, team: task.teamId, error: msg });

          // Report trigger failure for circuit breaker
          const triggerMatch = dequeued.correlationId?.match(/^trigger:([^:]+):/);
          if (triggerMatch) {
            this.#reportTriggerOutcome?.(task.teamId, triggerMatch[1], false);
          }
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
