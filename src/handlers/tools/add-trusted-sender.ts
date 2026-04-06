/**
 * add_trusted_sender tool — grants trust to a sender for a given channel type.
 *
 * Input: {channel_type, sender_id, channel_id?, trust_level?}
 * Writes a SenderTrustRecord via the ISenderTrustStore.
 */

import { z } from 'zod';
import type { ISenderTrustStore } from '../../domain/interfaces.js';

export const AddTrustedSenderInputSchema = z.object({
  channel_type: z.string().min(1),
  sender_id: z.string().min(1),
  channel_id: z.string().optional(),
  trust_level: z.string().default('trusted'),
});

export type AddTrustedSenderInput = z.infer<typeof AddTrustedSenderInputSchema>;

export interface AddTrustedSenderResult {
  readonly success: boolean;
  readonly reason?: string;
}

export interface AddTrustedSenderDeps {
  readonly senderTrustStore: ISenderTrustStore;
}

export function addTrustedSender(
  input: unknown,
  _callerId: string,
  deps: AddTrustedSenderDeps,
): AddTrustedSenderResult {
  const parsed = AddTrustedSenderInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, reason: `invalid input: ${parsed.error.message}` };
  }

  const { channel_type, sender_id, channel_id, trust_level } = parsed.data;

  deps.senderTrustStore.add({
    channelType: channel_type,
    senderId: sender_id,
    channelId: channel_id,
    trustLevel: trust_level,
    grantedBy: 'admin',
    createdAt: new Date().toISOString(),
  });

  return { success: true };
}
