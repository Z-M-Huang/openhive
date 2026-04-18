/**
 * enqueue_parent_task tool — enqueues a task to the caller's parent team.
 *
 * Design decisions (ADR, Unit 2):
 *
 * Payload field:        `task` (not `message`)
 * Payload format:       Prefixed: `[Work handoff from ${callerId}] ${task}`
 * sourceChannelId:      Passed through to the parent queue entry on every call.
 * Correlation ID:       Caller-supplied `correlation_id` is used when present;
 *                       otherwise auto-generated as `handoff:${callerId}:${Date.now()}:${randomHex(4)}`.
 * Deduplication:        ENABLED — duplicate correlation IDs within a 5-minute window
 *                       are rejected with `{ success: false, error: 'duplicate_correlation_id' }`.
 * Rate-cap:             ENABLED — per-caller limit of 5 handoffs per 60-second sliding window;
 *                       excess calls return `{ success: false, error: 'rate_limit_exceeded' }`.
 * Root team behaviour:  Returns `{ success: false, error: 'no_parent' }` and
 *                       enqueues nothing.
 */

import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import type { OrgTree } from '../../domain/org-tree.js';
import type { ITaskQueueStore } from '../../domain/interfaces.js';

// ── Schema ────────────────────────────────────────────────────────────────────

export const EnqueueParentTaskInputSchema = z.object({
  task: z.string().min(1),
  priority: z.enum(['low', 'normal', 'high', 'critical']).optional(),
  context: z.string().optional(),
  message_for_user: z.string().optional(),
  correlation_id: z.string().optional(),
});

export type EnqueueParentTaskInput = z.infer<typeof EnqueueParentTaskInputSchema>;

// ── Result & Deps ─────────────────────────────────────────────────────────────

export interface EnqueueParentTaskResult {
  readonly success: boolean;
  readonly correlation_id?: string;
  readonly error?: string;
}

export interface EnqueueParentTaskDeps {
  readonly taskQueue: ITaskQueueStore;
  readonly orgTree: OrgTree;
}

// ── In-process dedup & rate-cap state ────────────────────────────────────────

/** Seen correlation IDs mapped to their insertion timestamp (ms). */
const seenCorrelationIds = new Map<string, number>();

/** Per-caller call timestamps for sliding-window rate cap. */
const callerCallTimestamps = new Map<string, number[]>();

const DEDUP_WINDOW_MS = 5 * 60_000;   // 5 minutes
const RATE_CAP_WINDOW_MS = 60_000;    // 1 minute
const RATE_CAP_MAX = 5;               // max handoffs per caller per window

/** Returns a lowercase hex string of `n` random bytes. */
function randomHex(n: number): string {
  return randomBytes(n).toString('hex');
}

/** Purge expired dedup entries (called on each invocation to bound memory). */
function pruneDedup(now: number): void {
  for (const [id, ts] of seenCorrelationIds) {
    if (now - ts > DEDUP_WINDOW_MS) {
      seenCorrelationIds.delete(id);
    }
  }
}

/** Purge expired rate-cap timestamps for a caller. */
function pruneRateCap(callerId: string, now: number): number[] {
  const timestamps = (callerCallTimestamps.get(callerId) ?? []).filter(
    (ts) => now - ts < RATE_CAP_WINDOW_MS,
  );
  callerCallTimestamps.set(callerId, timestamps);
  return timestamps;
}

// ── Handler ───────────────────────────────────────────────────────────────────

/**
 * Enqueues a work-handoff task to the caller's parent team.
 *
 * - Returns `{ success: false, error: 'no_parent' }` for root teams.
 * - Prefixes the task body: `[Work handoff from ${callerId}] ${task}`.
 * - Passes `sourceChannelId` through to the queue entry.
 * - Auto-generates a structured correlation ID (`handoff:${callerId}:${timestamp}:${hex4}`)
 *   when the caller omits one.
 * - Rejects duplicate correlation IDs seen within the last 5 minutes.
 * - Enforces a per-caller rate cap of 5 handoffs per 60-second sliding window.
 */
export async function enqueueParentTask(
  input: EnqueueParentTaskInput,
  callerId: string,
  deps: EnqueueParentTaskDeps,
  sourceChannelId?: string,
): Promise<EnqueueParentTaskResult> {
  const parsed = EnqueueParentTaskInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: `invalid input: ${parsed.error.message}` };
  }

  const { task, priority, correlation_id } = parsed.data;
  const now = Date.now();

  // Rate-cap check
  const recentCalls = pruneRateCap(callerId, now);
  if (recentCalls.length >= RATE_CAP_MAX) {
    return { success: false, error: 'rate_limit_exceeded' };
  }

  // Look up the caller's team to find its parent
  const callerTeam = deps.orgTree.getTeam(callerId);
  if (!callerTeam) {
    return { success: false, error: `caller team "${callerId}" not found` };
  }

  // Root teams have no parent — stable failure shape
  if (!callerTeam.parentId) {
    return { success: false, error: 'no_parent' };
  }

  // Correlation ID — use caller-supplied or generate structured ID
  const correlationId = correlation_id ?? `handoff:${callerId}:${now}:${randomHex(4)}`;

  // Dedup check — reject IDs seen within the last 5 minutes
  pruneDedup(now);
  if (seenCorrelationIds.has(correlationId)) {
    return { success: false, error: 'duplicate_correlation_id' };
  }

  // Register rate-cap entry and dedup entry
  callerCallTimestamps.set(callerId, [...recentCalls, now]);
  seenCorrelationIds.set(correlationId, now);

  const taskBody = `[Work handoff from ${callerId}] ${task}`;

  deps.taskQueue.enqueue(
    callerTeam.parentId,
    taskBody,
    priority ?? 'normal',
    'delegate',
    sourceChannelId,
    correlationId,
  );

  return { success: true, correlation_id: correlationId };
}
