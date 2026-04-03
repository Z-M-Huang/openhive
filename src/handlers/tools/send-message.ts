/**
 * send_message tool — sends a message between related teams (parent/child).
 *
 * Input: {target: string, message: string}
 * Validates target is caller's parent or child via OrgTree.
 * For now, logs the message (delivery infrastructure TBD).
 */

import { z } from 'zod';
import type { OrgTree } from '../../domain/org-tree.js';

export const SendMessageInputSchema = z.object({
  target: z.string().min(1),
  message: z.string().min(1),
});

export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;

export interface SendMessageResult {
  readonly success: boolean;
  readonly error?: string;
}

export interface SendMessageDeps {
  readonly orgTree: OrgTree;
  readonly log: (msg: string, meta?: Record<string, unknown>) => void;
}

export function sendMessage(
  input: SendMessageInput,
  callerId: string,
  deps: SendMessageDeps,
): SendMessageResult {
  const parsed = SendMessageInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: `invalid input: ${parsed.error.message}` };
  }

  const { target, message } = parsed.data;

  // Validate caller and target exist
  const callerTeam = deps.orgTree.getTeam(callerId);
  if (!callerTeam) {
    return { success: false, error: `caller team "${callerId}" not found` };
  }

  const targetTeam = deps.orgTree.getTeam(target);
  if (!targetTeam) {
    return { success: false, error: `target team "${target}" not found` };
  }

  // Validate relationship: target must be caller's parent or child
  const isParent = callerTeam.parentId === target;
  const isChild = targetTeam.parentId === callerId;

  if (!isParent && !isChild) {
    return { success: false, error: 'target is neither parent nor child of caller' };
  }

  // Log the message (delivery infrastructure deferred)
  deps.log('send_message', { from: callerId, to: target, message });

  return { success: true };
}
