/**
 * Zod schemas and types for the trust policy section of channels.yaml.
 *
 * Trust policies control which senders and channels are allowed or denied
 * per channel adapter. When no trust: section is present, the default
 * behavior is allow-all (backward compatible).
 */

import { z } from 'zod';

// ── Channel-level trust config ─────────────────────────────────────────────

export const ChannelTrustSchema = z.object({
  policy: z.enum(['allow', 'deny']).optional(),
  sender_allowlist: z.array(z.string()).optional(),
  sender_denylist: z.array(z.string()).optional(),
  channel_overrides: z
    .record(z.string(), z.object({ policy: z.enum(['allow', 'deny']) }))
    .optional(),
});

export type ChannelTrustConfig = z.infer<typeof ChannelTrustSchema>;

// ── Top-level trust policy ─────────────────────────────────────────────────

export const TrustPolicySchema = z.object({
  default_policy: z.enum(['allow', 'deny']).default('allow'),
  channels: z.record(z.string(), ChannelTrustSchema).optional(),
});

export type TrustPolicy = z.infer<typeof TrustPolicySchema>;
