/* eslint-disable max-lines -- Task consumer owns the full dequeue/dispatch loop for all TaskTypes (delegate/trigger/escalation/bootstrap) plus window-cursor persistence hooks and circuit-breaker integration. Splitting by task type would fragment shared setup, retry/requeue policy, and lifecycle cleanup. */

/**
 * Task consumer — processes pending tasks for child teams.
 *
 * Polls the task queue and spawns SDK sessions for pending tasks.
 * Reports trigger outcomes back for circuit breaker accounting.
 */

import type { IMemoryStore, ITaskQueueStore, IInteractionStore } from '../domain/interfaces.js';
import { writeWindowCursors } from '../domain/interfaces.js';
import type { OrgTree } from '../domain/org-tree.js';
import type { TeamConfig } from '../domain/types.js';
import { TaskStatus } from '../domain/types.js';
import { handleMessage } from './message-handler.js';
import type { MessageHandlerDeps, MessageResult } from './message-handler.js';
import { scrubSecrets } from '../logging/credential-scrubber.js';
import { errorMessage } from '../domain/errors.js';
import { loadSubagents } from './skill-loader.js';
import type { SubagentDefinition } from './skill-loader.js';
import { seedLearningTriggersForTeam } from '../bootstrap-helpers.js';
import {
  TRIGGER_NOTIFY_INSTRUCTION,
  parseLlmNotifyDecision,
  stripNotifyBlock,
} from './task-consumer-notify.js';
import { safeJsonParse } from '../domain/safe-json.js';
import type { WindowCursorSnapshot } from '../domain/interfaces.js';

/**
 * Regex for the structured cursor-update block the LLM may emit in a trigger
 * task response (AC-46 write-at-end path through task-consumer).
 * Format: ```json:window_cursor\n{"last_scan_cursor":"...","last_event_id":"..."}```
 */
const CURSOR_BLOCK_RE = /```json:window_cursor\s*(\{[\s\S]*?\})\s*```/;

/**
 * Parse window cursor updates from the LLM response.
 * Returns null if no block present or if the JSON is malformed.
 */
function parseWindowCursorBlock(text: string): Partial<WindowCursorSnapshot> | null {
  const match = text.match(CURSOR_BLOCK_RE);
  if (!match) return null;
  return safeJsonParse<Partial<WindowCursorSnapshot>>(match[1], 'window-cursor-block') ?? null;
}

/**
 * Strip the cursor-update block from the stored/displayed response.
 */
function stripWindowCursorBlock(text: string): string {
  return text.replace(CURSOR_BLOCK_RE, '').trim();
}

// Re-exported so callers that previously imported from task-consumer keep working.
export { TRIGGER_NOTIFY_INSTRUCTION, parseLlmNotifyDecision, stripNotifyBlock };

/**
 * Function injected for testability — verifies the subagent exists under a team.
 * Default uses the filesystem loader; tests can override to avoid fs reads.
 */
export type SubagentLoader = (runDir: string, teamName: string) => Record<string, SubagentDefinition>;

export interface TaskConsumerOpts {
  readonly taskQueueStore: ITaskQueueStore;
  readonly orgTree: OrgTree;
  readonly handlerDeps: MessageHandlerDeps;
  readonly pollIntervalMs?: number;
  readonly notifyChannel?: (content: string, sourceChannelId?: string | null) => Promise<void>;
  readonly getTeamConfig?: (teamId: string) => TeamConfig | undefined;
  readonly reportTriggerOutcome?: (team: string, triggerName: string, success: boolean, taskId?: string) => void;
  readonly interactionStore?: IInteractionStore;
  /**
   * Memory store for writing window cursor updates parsed from trigger task
   * results (AC-46 write-at-end path).
   */
  readonly memoryStore?: IMemoryStore;
  /**
   * Override the default filesystem-backed subagent loader. Tests use this
   * to supply in-memory subagent definitions without touching runDir.
   */
  readonly loadSubagents?: SubagentLoader;
}

export class TaskConsumer {
  readonly #taskQueue: ITaskQueueStore;
  readonly #orgTree: OrgTree;
  readonly #deps: MessageHandlerDeps;
  readonly #pollMs: number;
  readonly #notifyChannel?: (content: string, sourceChannelId?: string | null) => Promise<void>;
  readonly #reportTriggerOutcome?: (team: string, triggerName: string, success: boolean, taskId?: string) => void;
  readonly #interactionStore?: IInteractionStore;
  readonly #loadSubagents: SubagentLoader;
  readonly #memoryStore?: IMemoryStore;
  #timer: ReturnType<typeof setInterval> | null = null;
  #processing = false;

  constructor(opts: TaskConsumerOpts) {
    this.#taskQueue = opts.taskQueueStore;
    this.#orgTree = opts.orgTree;
    this.#deps = opts.handlerDeps;
    this.#pollMs = opts.pollIntervalMs ?? 5_000;
    this.#notifyChannel = opts.notifyChannel;
    this.#reportTriggerOutcome = opts.reportTriggerOutcome;
    this.#interactionStore = opts.interactionStore;
    this.#memoryStore = opts.memoryStore;
    this.#loadSubagents = opts.loadSubagents ?? loadSubagents;
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

  // eslint-disable-next-line max-lines-per-function, complexity -- Task dispatch state machine; refactor would fragment per-task lifecycle handling.
  async #tick(): Promise<void> {
    if (this.#processing) return;
    this.#processing = true;

    try {
      const pending = this.#taskQueue.getPending();
      for (const task of pending) {
        const dequeued = this.#taskQueue.dequeue(task.teamId);
        if (!dequeued) continue;

        // Skip bootstrap tasks for already-bootstrapped teams
        if (dequeued.type === 'bootstrap' && this.#orgTree.isBootstrapped(dequeued.teamId)) {
          this.#taskQueue.updateStatus(dequeued.id, TaskStatus.Done);
          continue;
        }

        try {
          let taskContent = dequeued.task;

          // For trigger-originated tasks, inject notification decision instruction
          const isTriggerTask = dequeued.type === 'trigger';
          if (isTriggerTask) {
            taskContent += TRIGGER_NOTIFY_INSTRUCTION;
          }

          // Read typed task options (snapshot at enqueue time)
          const maxSteps = dequeued.options?.maxSteps;
          const subagent = dequeued.options?.subagent;

          // Validate subagent before execution (Risk-13 mitigation): a queued task
          // whose subagent no longer exists on disk must fail safely — not silently
          // fall back to a different identity or the team default.
          if (subagent !== undefined) {
            const available = this.#loadSubagents(this.#deps.runDir, task.teamId);
            if (!available[subagent]) {
              const known = Object.keys(available);
              const hint = known.length > 0
                ? ` (available: ${known.join(', ')})`
                : ' (no subagents defined for this team)';
              const error = `Unknown subagent "${subagent}" for team "${task.teamId}"${hint}`;
              this.#taskQueue.updateStatus(dequeued.id, TaskStatus.Failed);
              this.#taskQueue.updateResult(dequeued.id, `Error: ${error}`);
              this.#deps.logger.info('Task failed (unknown subagent)', {
                taskId: dequeued.id, team: task.teamId, subagent, available: known,
              });
              // Report trigger outcome for circuit breaker so repeated bad subagent
              // references eventually trip the breaker.
              const triggerMatch = dequeued.correlationId?.match(/^trigger:([^:]+):/);
              if (triggerMatch) {
                this.#reportTriggerOutcome?.(task.teamId, triggerMatch[1], false, dequeued.id);
              }
              continue;
            }
          }

          const result: MessageResult = await handleMessage(
            {
              channelId: `task:${dequeued.id}`,
              userId: 'system',
              content: taskContent,
              timestamp: Date.now(),
            },
            { ...this.#deps, orgAncestors: this.#getAncestorNames(task.teamId) },
            {
              teamName: task.teamId, maxSteps,
              sourceChannelId: dequeued.sourceChannelId ?? undefined,
              topicId: dequeued.topicId ?? undefined,
              subagent,
            },
          );

          // Stale outcome guard — task may have been cancelled by overlap policy during execution
          const currentTask = this.#taskQueue.getById(dequeued.id);
          if (currentTask?.status === TaskStatus.Cancelled) {
            // Task cancelled by overlap policy — don't overwrite, don't notify
            continue;
          }

          const isError = !result.ok;
          this.#taskQueue.updateStatus(dequeued.id, isError ? TaskStatus.Failed : TaskStatus.Done);

          // Mark team as bootstrapped on successful bootstrap task completion.
          // Seed learning/reflection triggers now that subagents are authored
          // on disk (Bug #1: replaces the speculative seeding that ran at spawn
          // time before any subagent could exist).
          if (dequeued.type === 'bootstrap' && !isError) {
            this.#orgTree.setBootstrapped(dequeued.teamId);
            if (this.#deps.triggerConfigStore) {
              seedLearningTriggersForTeam(this.#deps.runDir, dequeued.teamId, this.#deps.triggerConfigStore);
            }
          }

          // Record duration
          if (this.#taskQueue.updateDuration) {
            this.#taskQueue.updateDuration(dequeued.id, result.durationMs);
          }

          // Report trigger outcome for circuit breaker
          const triggerMatch = dequeued.correlationId?.match(/^trigger:([^:]+):/);
          if (triggerMatch) {
            this.#reportTriggerOutcome?.(task.teamId, triggerMatch[1], !isError, dequeued.id);
          }

          // Build safe response text
          const responseText = result.ok ? result.content : `Error: ${result.error}`;
          let safeResponse = responseText;
          if (responseText) {
            // Scrub with vault secrets only (AC-10) — never config credentials
            const vaultSecrets = this.#deps.vaultStore?.getSecrets(task.teamId) ?? [];
            const credValues = vaultSecrets.map((e) => e.value).filter((v) => v.length >= 8);
            if (credValues.length > 0) safeResponse = scrubSecrets(responseText, [], credValues);
          }

          // For trigger tasks, parse LLM notification decision and strip the block
          let shouldNotify = true;
          if (isTriggerTask && safeResponse) {
            const decision = parseLlmNotifyDecision(safeResponse);
            shouldNotify = decision.notify;
            safeResponse = stripNotifyBlock(safeResponse);
            this.#deps.logger.info('LLM notification decision', {
              team: task.teamId, notify: decision.notify, reason: decision.reason,
            });
          }

          // AC-46: parse window cursor updates from trigger task results and
          // write them via the shared memory lock path (AC-67).
          if (isTriggerTask && safeResponse && this.#memoryStore) {
            const subagentName = dequeued.options?.subagent;
            if (subagentName) {
              const cursorUpdates = parseWindowCursorBlock(safeResponse);
              if (cursorUpdates) {
                safeResponse = stripWindowCursorBlock(safeResponse);
                try {
                  writeWindowCursors(this.#memoryStore, task.teamId, subagentName, cursorUpdates);
                } catch (err) {
                  this.#deps.logger.info('Window cursor write failed', {
                    taskId: dequeued.id, team: task.teamId, subagent: subagentName, error: errorMessage(err),
                  });
                }
              }
            }
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

          // Notify originating channel (or broadcast if no source)
          // Bootstrap tasks get a clean summary — no implementation details
          if (this.#notifyChannel) {
            const isInternal = dequeued.type === 'bootstrap';
            let notif: string | null = null;
            if (isInternal) {
              notif = isError
                ? `[${task.teamId}] Team bootstrap failed — check logs for details.`
                : `[${task.teamId}] Team bootstrapped and ready.`;
            } else if (shouldNotify && safeResponse) {
              notif = `[${task.teamId}] ${safeResponse}`;
            }
            if (notif) {
              this.#notifyChannel(notif, dequeued.sourceChannelId).catch((err) => {
                this.#deps.logger.info('Notification delivery failed', {
                  taskId: dequeued.id, team: task.teamId, error: errorMessage(err),
                });
              });

              if (dequeued.sourceChannelId) {
                try {
                  this.#interactionStore?.log({
                    direction: 'outbound',
                    channelType: dequeued.sourceChannelId.startsWith('ws:') ? 'ws' : dequeued.sourceChannelId.startsWith('discord:') ? 'discord' : 'other',
                    channelId: dequeued.sourceChannelId,
                    teamId: task.teamId,
                    contentSnippet: notif.slice(0, 2000),
                    contentLength: notif.length,
                  });
                } catch { /* logging must not crash task processing */ }
              }
            }
          }
        } catch (err) {
          this.#taskQueue.updateStatus(dequeued.id, TaskStatus.Failed);
          const msg = errorMessage(err);
          this.#deps.logger.info('Task failed', { taskId: dequeued.id, team: task.teamId, error: msg });

          // Report trigger failure for circuit breaker
          const triggerMatch = dequeued.correlationId?.match(/^trigger:([^:]+):/);
          if (triggerMatch) {
            this.#reportTriggerOutcome?.(task.teamId, triggerMatch[1], false, dequeued.id);
          }
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
