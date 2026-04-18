/**
 * escalate tool — escalates an issue to the caller's parent team.
 *
 * Input: {message: string, reason?: string}
 * Finds parent via OrgTree. Persists to escalation store. Queues for parent with high priority.
 */

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { OrgTree } from '../../domain/org-tree.js';
import type { IEscalationStore, ITaskQueueStore } from '../../domain/interfaces.js';

export const EscalateInputSchema = z.object({
  message: z.string().min(1),
  reason: z.string().optional(),
});

export type EscalateInput = z.infer<typeof EscalateInputSchema>;

export interface EscalateResult {
  readonly success: boolean;
  readonly correlation_id?: string;
  readonly notification_only?: boolean;
  readonly error?: string;
}

export interface EscalateDeps {
  readonly orgTree: OrgTree;
  readonly escalationStore: IEscalationStore;
  readonly taskQueue: ITaskQueueStore;
}

export function escalate(
  input: EscalateInput,
  callerId: string,
  deps: EscalateDeps,
  sourceChannelId?: string,
): EscalateResult {
  const parsed = EscalateInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: `invalid input: ${parsed.error.message}` };
  }

  const { message } = parsed.data;

  // Find caller's team and parent
  const callerTeam = deps.orgTree.getTeam(callerId);
  if (!callerTeam) {
    return { success: false, error: `caller team "${callerId}" not found` };
  }

  if (!callerTeam.parentId) {
    // Root team — escalate to user via channel (ADR-36)
    const correlationId = `escalation:root:${Date.now()}`;
    deps.taskQueue.enqueue(callerId, message, 'high', 'escalation', sourceChannelId, correlationId);
    return { success: true, correlation_id: correlationId };
  }

  // ADR-43 (discovery B3 correction): non-root escalate is notification-only.
  // Persist the correlation record, but do NOT enqueue to the parent queue —
  // for work handoff, the tool surface exposes enqueue_parent_task instead.
  const correlationId = randomUUID();

  deps.escalationStore.create({
    correlationId,
    sourceTeam: callerId,
    targetTeam: callerTeam.parentId,
    taskId: null,
    status: 'pending',
    createdAt: new Date().toISOString(),
  });

  void sourceChannelId; // retained on signature for future correlation threading

  return { success: true, correlation_id: correlationId, notification_only: true };
}
