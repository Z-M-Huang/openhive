/**
 * TrustGate evaluator — pure logic, no side effects.
 *
 * 6-step eval chain (first match wins):
 *   1. sender_denylist  -> deny_silent
 *   2. DB lookup        -> allow (trusted) / deny_silent (denied)
 *   3. sender_allowlist -> allow
 *   4. channel_overrides -> allow / deny_respond
 *   5. channel policy   -> allow / deny_respond
 *   6. default_policy   -> allow / deny_respond
 *
 * CLI is always trusted — hardcoded bypass before any evaluation.
 * No trust config => allow all.
 * DB errors at step 2 are caught and skipped (fail-closed via remaining steps).
 */

import type { TrustPolicy, ChannelTrustConfig } from '../config/trust-policy.js';
import type { ISenderTrustStore } from '../domain/interfaces.js';

// ── Types ─────────────────────────────────────────────────────────────────

export type TrustDecision = 'allow' | 'deny_silent' | 'deny_respond';

export interface TrustEvalResult {
  readonly decision: TrustDecision;
  readonly reason: string;
}

export interface EvaluateTrustOpts {
  readonly channelType: string;
  readonly channelId: string;
  readonly senderId: string;
  readonly trustPolicy?: TrustPolicy;
  readonly senderTrustStore?: ISenderTrustStore;
}

// ── Evaluator ─────────────────────────────────────────────────────────────

export function evaluateTrust(opts: EvaluateTrustOpts): TrustEvalResult {
  const { channelType, channelId, senderId, trustPolicy } = opts;
  const senderTrustStore = opts.senderTrustStore;

  // CLI is always trusted — no eval, no DB, no audit
  if (channelType === 'cli') {
    return { decision: 'allow', reason: 'cli_bypass' };
  }

  // No trust config => allow all
  if (!trustPolicy) {
    return { decision: 'allow', reason: 'no_trust_config' };
  }

  const channelConfig: ChannelTrustConfig | undefined = trustPolicy.channels?.[channelType];

  // Step 1: sender_denylist from YAML config
  if (channelConfig?.sender_denylist?.length) {
    if (channelConfig.sender_denylist.includes(senderId)) {
      return { decision: 'deny_silent', reason: 'sender_denylist' };
    }
  }

  // Step 2: DB lookup via senderTrustStore
  if (senderTrustStore) {
    try {
      const record = senderTrustStore.get(channelType, senderId, channelId);
      if (record) {
        if (record.trustLevel === 'trusted') {
          return { decision: 'allow', reason: 'db_trusted' };
        }
        if (record.trustLevel === 'denied') {
          return { decision: 'deny_silent', reason: 'db_denied' };
        }
      }
    } catch {
      // DB error — skip step 2, proceed to remaining steps
    }
  }

  // Step 3: sender_allowlist from YAML config
  if (channelConfig?.sender_allowlist?.length) {
    if (channelConfig.sender_allowlist.includes(senderId)) {
      return { decision: 'allow', reason: 'sender_allowlist' };
    }
  }

  // Step 4: channel_overrides for this channelId
  if (channelConfig?.channel_overrides) {
    const override = channelConfig.channel_overrides[channelId];
    if (override) {
      if (override.policy === 'allow') {
        return { decision: 'allow', reason: 'channel_override_allow' };
      }
      return { decision: 'deny_respond', reason: 'channel_override_deny' };
    }
  }

  // Step 5: channel policy
  if (channelConfig?.policy) {
    if (channelConfig.policy === 'allow') {
      return { decision: 'allow', reason: 'channel_policy_allow' };
    }
    return { decision: 'deny_respond', reason: 'channel_policy_deny' };
  }

  // Step 6: default_policy
  if (trustPolicy.default_policy === 'allow') {
    return { decision: 'allow', reason: 'default_policy_allow' };
  }
  return { decision: 'deny_respond', reason: 'default_policy_deny' };
}
