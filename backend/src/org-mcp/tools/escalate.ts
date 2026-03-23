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
import { TaskPriority } from '../../domain/types.js';

export const EscalateInputSchema = z.object({
  message: z.string().min(1),
  reason: z.string().optional(),
});

export type EscalateInput = z.infer<typeof EscalateInputSchema>;

export interface EscalateResult {
  readonly success: boolean;
  readonly correlation_id?: string;
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
): EscalateResult {
  const parsed = EscalateInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: `invalid input: ${parsed.error.message}` };
  }

  const { message, reason } = parsed.data;

  // Find caller's team and parent
  const callerTeam = deps.orgTree.getTeam(callerId);
  if (!callerTeam) {
    return { success: false, error: `caller team "${callerId}" not found` };
  }

  if (!callerTeam.parentId) {
    return { success: false, error: 'caller has no parent to escalate to' };
  }

  const correlationId = randomUUID();
  const escalationMessage = reason ? `[Escalation: ${reason}] ${message}` : `[Escalation] ${message}`;

  // Persist to escalation store
  deps.escalationStore.create({
    correlationId,
    sourceTeam: callerId,
    targetTeam: callerTeam.parentId,
    taskId: null,
    status: 'pending',
    createdAt: new Date().toISOString(),
  });

  // Queue task for parent team with high priority
  deps.taskQueue.enqueue(
    callerTeam.parentId,
    escalationMessage,
    TaskPriority.High,
    correlationId,
  );

  return { success: true, correlation_id: correlationId };
}
