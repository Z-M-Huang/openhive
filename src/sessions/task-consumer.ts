/**
 * Task consumer — processes pending tasks for child teams.
 *
 * Polls the task queue and spawns SDK sessions for pending tasks.
 * Reports trigger outcomes back for circuit breaker accounting.
 */

import type { ITaskQueueStore, IInteractionStore } from '../domain/interfaces.js';
import type { OrgTree } from '../domain/org-tree.js';
import type { TeamConfig } from '../domain/types.js';
import { TaskStatus } from '../domain/types.js';
import { handleMessage } from './message-handler.js';
import type { MessageHandlerDeps, MessageResult } from './message-handler.js';
import { scrubSecrets } from '../logging/credential-scrubber.js';
import { errorMessage } from '../domain/errors.js';
import { extractStringCredentials } from '../domain/credential-utils.js';
import { safeJsonParse } from '../domain/safe-json.js';

// ── Notification decision parsing ──────────────────────────────────────────

/** Regex to extract the notify JSON block (```json:notify ... ```) from LLM response. */
const NOTIFY_BLOCK_RE = /```json:notify\s*(\{[^}]*"notify"\s*:\s*(?:true|false)[^}]*\})\s*```/s;

/** Instruction appended to trigger-originated tasks so the LLM decides whether to notify. */
export const TRIGGER_NOTIFY_INSTRUCTION = `
---
## Notification Decision
This task was triggered automatically. After completing it, decide whether the user should be notified about this result.

At the END of your response, include a JSON block with your decision:

\`\`\`json:notify
{"notify": true, "reason": "Brief reason for your decision"}
\`\`\`

Set \`notify\` to \`true\` if the result has new, important, or actionable information the user should see.
Set \`notify\` to \`false\` if the result is routine, unchanged, or not worth interrupting the user.

Ask yourself: Is there something genuinely new? Did something fail unexpectedly? Would the user want to act on this? When in doubt, notify.`;

/**
 * Parse the LLM's notification decision from a ```json:notify block.
 * Fail-safe: returns { notify: true } if missing, malformed, or unparseable.
 */
export function parseLlmNotifyDecision(text: string | undefined): { notify: boolean; reason?: string } {
  if (!text) return { notify: true };
  const match = text.match(NOTIFY_BLOCK_RE);
  if (!match) return { notify: true };
  const parsed = safeJsonParse<{ notify: boolean; reason?: string }>(match[1], 'notify-decision');
  if (!parsed || typeof parsed.notify !== 'boolean') return { notify: true };
  return { notify: parsed.notify, reason: parsed.reason };
}

/**
 * Strip the notify JSON block and any echoed instruction from displayed/stored content.
 * Removes ```json:notify blocks and <notify_decision>...</notify_decision> tags.
 */
export function stripNotifyBlock(text: string): string {
  // Strip <notify_decision>...</notify_decision> tags (may wrap the block)
  let cleaned = text.replace(/<notify_decision>[\s\S]*?<\/notify_decision>/g, '');

  // Try removing from the "---\n## Notification Decision" marker onward
  const sectionStripped = cleaned.replace(/\n---\n## Notification Decision[\s\S]*$/, '').trim();
  if (sectionStripped && sectionStripped !== cleaned.trim()) {
    return sectionStripped;
  }

  // Fallback: just remove the json:notify block itself
  cleaned = cleaned.replace(NOTIFY_BLOCK_RE, '').trim();
  return cleaned;
}

export interface TaskConsumerOpts {
  readonly taskQueueStore: ITaskQueueStore;
  readonly orgTree: OrgTree;
  readonly handlerDeps: MessageHandlerDeps;
  readonly pollIntervalMs?: number;
  readonly notifyChannel?: (content: string, sourceChannelId?: string | null) => Promise<void>;
  readonly getTeamConfig?: (teamId: string) => TeamConfig | undefined;
  readonly reportTriggerOutcome?: (team: string, triggerName: string, success: boolean) => void;
  readonly interactionStore?: IInteractionStore;
}

export class TaskConsumer {
  readonly #taskQueue: ITaskQueueStore;
  readonly #orgTree: OrgTree;
  readonly #deps: MessageHandlerDeps;
  readonly #pollMs: number;
  readonly #notifyChannel?: (content: string, sourceChannelId?: string | null) => Promise<void>;
  readonly #getTeamConfig?: (teamId: string) => TeamConfig | undefined;
  readonly #reportTriggerOutcome?: (team: string, triggerName: string, success: boolean) => void;
  readonly #interactionStore?: IInteractionStore;
  #timer: ReturnType<typeof setInterval> | null = null;
  #processing = false;

  constructor(opts: TaskConsumerOpts) {
    this.#taskQueue = opts.taskQueueStore;
    this.#orgTree = opts.orgTree;
    this.#deps = opts.handlerDeps;
    this.#pollMs = opts.pollIntervalMs ?? 5_000;
    this.#notifyChannel = opts.notifyChannel;
    this.#getTeamConfig = opts.getTeamConfig;
    this.#reportTriggerOutcome = opts.reportTriggerOutcome;
    this.#interactionStore = opts.interactionStore;
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

        // Skip bootstrap tasks for already-bootstrapped teams
        if (dequeued.type === 'bootstrap' && this.#orgTree.isBootstrapped(dequeued.teamId)) {
          this.#taskQueue.updateStatus(dequeued.id, TaskStatus.Completed);
          continue;
        }

        try {
          // Replace [CREDENTIAL:xxx] placeholders with get_credential instructions
          let taskContent = dequeued.task.replace(
            /\[CREDENTIAL:(\w+)\]/g,
            (_, key: string) => `(use get_credential({ key: "${key}" }) to retrieve this value)`,
          );

          // For trigger-originated tasks, inject notification decision instruction
          const isTriggerTask = dequeued.type === 'trigger';
          if (isTriggerTask) {
            taskContent += TRIGGER_NOTIFY_INSTRUCTION;
          }

          // Read maxTurns from typed task options (snapshot at enqueue time)
          const maxTurns = dequeued.options?.maxTurns;

          const result: MessageResult = await handleMessage(
            {
              channelId: `task:${dequeued.id}`,
              userId: 'system',
              content: taskContent,
              timestamp: Date.now(),
            },
            { ...this.#deps, orgAncestors: this.#getAncestorNames(task.teamId) },
            {
              teamName: task.teamId, maxTurns,
              sourceChannelId: dequeued.sourceChannelId ?? undefined,
              topicId: dequeued.topicId ?? undefined,
            },
          );

          const isError = !result.ok;
          this.#taskQueue.updateStatus(dequeued.id, isError ? TaskStatus.Failed : TaskStatus.Completed);

          // Mark team as bootstrapped on successful bootstrap task completion
          if (dequeued.type === 'bootstrap' && !isError) {
            this.#orgTree.setBootstrapped(dequeued.teamId);
          }

          // Record duration
          if (this.#taskQueue.updateDuration) {
            this.#taskQueue.updateDuration(dequeued.id, result.durationMs);
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
            const creds = extractStringCredentials(config?.credentials ?? {});
            if (creds.length > 0) safeResponse = scrubSecrets(responseText, [], creds);
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
            this.#reportTriggerOutcome?.(task.teamId, triggerMatch[1], false);
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
