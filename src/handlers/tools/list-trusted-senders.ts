/**
 * list_trusted_senders tool — lists trusted senders, optionally filtered.
 *
 * Input: {channel_type?, trust_level?}
 * Returns matching SenderTrustRecords via ISenderTrustStore.
 */

import { z } from 'zod';
import type { ISenderTrustStore, SenderTrustRecord } from '../../domain/interfaces.js';

export const ListTrustedSendersInputSchema = z.object({
  channel_type: z.string().optional(),
  trust_level: z.string().optional(),
});

export type ListTrustedSendersInput = z.infer<typeof ListTrustedSendersInputSchema>;

export interface ListTrustedSendersResult {
  readonly success: boolean;
  readonly senders?: SenderTrustRecord[];
  readonly reason?: string;
}

export interface ListTrustedSendersDeps {
  readonly senderTrustStore: ISenderTrustStore;
}

export function listTrustedSenders(
  input: unknown,
  _callerId: string,
  deps: ListTrustedSendersDeps,
): ListTrustedSendersResult {
  const parsed = ListTrustedSendersInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, reason: `invalid input: ${parsed.error.message}` };
  }

  const { channel_type, trust_level } = parsed.data;

  const senders = deps.senderTrustStore.list(channel_type, trust_level);

  return { success: true, senders };
}
