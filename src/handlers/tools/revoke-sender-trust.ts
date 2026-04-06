/**
 * revoke_sender_trust tool — removes trust from a sender for a given channel type.
 *
 * Input: {channel_type, sender_id, channel_id?}
 * Removes the matching SenderTrustRecord via ISenderTrustStore.
 */

import { z } from 'zod';
import type { ISenderTrustStore } from '../../domain/interfaces.js';

export const RevokeSenderTrustInputSchema = z.object({
  channel_type: z.string().min(1),
  sender_id: z.string().min(1),
  channel_id: z.string().optional(),
});

export type RevokeSenderTrustInput = z.infer<typeof RevokeSenderTrustInputSchema>;

export interface RevokeSenderTrustResult {
  readonly success: boolean;
  readonly reason?: string;
}

export interface RevokeSenderTrustDeps {
  readonly senderTrustStore: ISenderTrustStore;
}

export function revokeSenderTrust(
  input: unknown,
  _callerId: string,
  deps: RevokeSenderTrustDeps,
): RevokeSenderTrustResult {
  const parsed = RevokeSenderTrustInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, reason: `invalid input: ${parsed.error.message}` };
  }

  const { channel_type, sender_id, channel_id } = parsed.data;

  deps.senderTrustStore.remove(channel_type, sender_id, channel_id);

  return { success: true };
}
