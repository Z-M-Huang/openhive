/**
 * TrustGate evaluator unit tests.
 *
 * Covers the 6-step eval chain, CLI bypass, no-config allow-all,
 * DB error handling, and precedence rules.
 */

import { describe, it, expect } from 'vitest';
import { evaluateTrust } from './trust-gate.js';
import type { EvaluateTrustOpts } from './trust-gate.js';
import type { TrustPolicy } from '../config/trust-policy.js';
import type { ISenderTrustStore, SenderTrustRecord } from '../domain/interfaces.js';

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * In-memory ISenderTrustStore — mirrors trust-tools.test.ts pattern.
 * When `fixedRecord` is provided, it's seeded into the store keyed by
 * the BASE_OPTS channel/sender values so get() finds it naturally.
 */
function createMockStore(): ISenderTrustStore & { records: SenderTrustRecord[] } {
  const records: SenderTrustRecord[] = [];
  return {
    records,
    add(record: SenderTrustRecord): void {
      records.push(record);
    },
    remove(channelType: string, senderId: string, channelId?: string): void {
      const idx = records.findIndex(
        (r) =>
          r.channelType === channelType &&
          r.senderId === senderId &&
          r.channelId === channelId,
      );
      if (idx !== -1) records.splice(idx, 1);
    },
    get(channelType: string, senderId: string, channelId?: string): SenderTrustRecord | undefined {
      return records.find(
        (r) =>
          r.channelType === channelType &&
          r.senderId === senderId &&
          r.channelId === channelId,
      );
    },
    list(channelType?: string, trustLevel?: string): SenderTrustRecord[] {
      return records.filter((r) => {
        if (channelType && r.channelType !== channelType) return false;
        if (trustLevel && r.trustLevel !== trustLevel) return false;
        return true;
      });
    },
  };
}

/** Convenience: create a mock store pre-seeded with a record. */
function stubStore(record?: SenderTrustRecord): ISenderTrustStore {
  const store = createMockStore();
  if (record) store.add(record);
  return store;
}

/** Stub store whose get() always throws -- simulates DB failure. */
function throwingStore(): ISenderTrustStore {
  const store = createMockStore();
  store.get = () => { throw new Error('SQLITE_BUSY'); };
  return store;
}

/** Create a SenderTrustRecord with defaults matching BASE_OPTS. */
function makeRecord(overrides: Partial<SenderTrustRecord> = {}): SenderTrustRecord {
  return {
    channelType: 'discord',
    channelId: 'general',
    senderId: 'user-1',
    trustLevel: 'trusted',
    grantedBy: 'admin',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const BASE_OPTS: Pick<EvaluateTrustOpts, 'channelType' | 'channelId' | 'senderId'> = {
  channelType: 'discord',
  channelId: 'general',
  senderId: 'user-1',
};

// ── Tests ─────────────────────────────────────────────────────────────────

describe('evaluateTrust', () => {
  // ── 1. CLI always trusted ───────────────────────────────────────────────

  it('CLI is always trusted regardless of policy', () => {
    const policy: TrustPolicy = { default_policy: 'deny', channels: { cli: { policy: 'deny' } } };
    const result = evaluateTrust({
      channelType: 'cli',
      channelId: '',
      senderId: 'local',
      trustPolicy: policy,
      senderTrustStore: stubStore(makeRecord({ trustLevel: 'denied' })),
    });
    expect(result).toEqual({ decision: 'allow', reason: 'cli_bypass' });
  });

  it('CLI trusted even without trust config', () => {
    const result = evaluateTrust({
      channelType: 'cli',
      channelId: '',
      senderId: 'local',
    });
    expect(result).toEqual({ decision: 'allow', reason: 'cli_bypass' });
  });

  // ── 2. No trust config → allow all ─────────────────────────────────────

  it('no trust config returns allow', () => {
    const result = evaluateTrust({ ...BASE_OPTS });
    expect(result).toEqual({ decision: 'allow', reason: 'no_trust_config' });
  });

  it('undefined trustPolicy returns allow', () => {
    const result = evaluateTrust({ ...BASE_OPTS, trustPolicy: undefined });
    expect(result).toEqual({ decision: 'allow', reason: 'no_trust_config' });
  });

  // ── 3. Denylist match → deny_silent ────────────────────────────────────

  it('denylist match returns deny_silent', () => {
    const policy: TrustPolicy = {
      default_policy: 'allow',
      channels: { discord: { sender_denylist: ['user-1', 'spammer'] } },
    };
    const result = evaluateTrust({ ...BASE_OPTS, trustPolicy: policy });
    expect(result).toEqual({ decision: 'deny_silent', reason: 'sender_denylist' });
  });

  it('denylist miss falls through', () => {
    const policy: TrustPolicy = {
      default_policy: 'allow',
      channels: { discord: { sender_denylist: ['other-user'] } },
    };
    const result = evaluateTrust({ ...BASE_OPTS, trustPolicy: policy });
    expect(result).toEqual({ decision: 'allow', reason: 'default_policy_allow' });
  });

  it('empty denylist array is skipped', () => {
    const policy: TrustPolicy = {
      default_policy: 'allow',
      channels: { discord: { sender_denylist: [] } },
    };
    const result = evaluateTrust({ ...BASE_OPTS, trustPolicy: policy });
    expect(result).toEqual({ decision: 'allow', reason: 'default_policy_allow' });
  });

  // ── 4. DB trusted → allow ──────────────────────────────────────────────

  it('DB trusted record returns allow', () => {
    const policy: TrustPolicy = { default_policy: 'deny' };
    const store = stubStore(makeRecord({ trustLevel: 'trusted' }));
    const result = evaluateTrust({ ...BASE_OPTS, trustPolicy: policy, senderTrustStore: store });
    expect(result).toEqual({ decision: 'allow', reason: 'db_trusted' });
  });

  // ── 5. DB denied → deny_silent ─────────────────────────────────────────

  it('DB denied record returns deny_silent', () => {
    const policy: TrustPolicy = { default_policy: 'allow' };
    const store = stubStore(makeRecord({ trustLevel: 'denied' }));
    const result = evaluateTrust({ ...BASE_OPTS, trustPolicy: policy, senderTrustStore: store });
    expect(result).toEqual({ decision: 'deny_silent', reason: 'db_denied' });
  });

  // ── 6. Allowlist match → allow ─────────────────────────────────────────

  it('allowlist match returns allow', () => {
    const policy: TrustPolicy = {
      default_policy: 'deny',
      channels: { discord: { sender_allowlist: ['user-1'] } },
    };
    const result = evaluateTrust({ ...BASE_OPTS, trustPolicy: policy });
    expect(result).toEqual({ decision: 'allow', reason: 'sender_allowlist' });
  });

  it('empty allowlist array is skipped', () => {
    const policy: TrustPolicy = {
      default_policy: 'deny',
      channels: { discord: { sender_allowlist: [] } },
    };
    const result = evaluateTrust({ ...BASE_OPTS, trustPolicy: policy });
    expect(result).toEqual({ decision: 'deny_respond', reason: 'default_policy_deny' });
  });

  // ── 7. Channel override allow → allow ──────────────────────────────────

  it('channel override allow returns allow', () => {
    const policy: TrustPolicy = {
      default_policy: 'deny',
      channels: { discord: { channel_overrides: { general: { policy: 'allow' } } } },
    };
    const result = evaluateTrust({ ...BASE_OPTS, trustPolicy: policy });
    expect(result).toEqual({ decision: 'allow', reason: 'channel_override_allow' });
  });

  // ── 8. Channel override deny → deny_respond ───────────────────────────

  it('channel override deny returns deny_respond', () => {
    const policy: TrustPolicy = {
      default_policy: 'allow',
      channels: { discord: { channel_overrides: { general: { policy: 'deny' } } } },
    };
    const result = evaluateTrust({ ...BASE_OPTS, trustPolicy: policy });
    expect(result).toEqual({ decision: 'deny_respond', reason: 'channel_override_deny' });
  });

  it('channel override for different channelId is skipped', () => {
    const policy: TrustPolicy = {
      default_policy: 'allow',
      channels: { discord: { channel_overrides: { other: { policy: 'deny' } } } },
    };
    const result = evaluateTrust({ ...BASE_OPTS, trustPolicy: policy });
    expect(result).toEqual({ decision: 'allow', reason: 'default_policy_allow' });
  });

  // ── 9. Channel policy deny → deny_respond ─────────────────────────────

  it('channel policy deny returns deny_respond', () => {
    const policy: TrustPolicy = {
      default_policy: 'allow',
      channels: { discord: { policy: 'deny' } },
    };
    const result = evaluateTrust({ ...BASE_OPTS, trustPolicy: policy });
    expect(result).toEqual({ decision: 'deny_respond', reason: 'channel_policy_deny' });
  });

  it('channel policy allow returns allow', () => {
    const policy: TrustPolicy = {
      default_policy: 'deny',
      channels: { discord: { policy: 'allow' } },
    };
    const result = evaluateTrust({ ...BASE_OPTS, trustPolicy: policy });
    expect(result).toEqual({ decision: 'allow', reason: 'channel_policy_allow' });
  });

  // ── 10. Default policy deny → deny_respond ────────────────────────────

  it('default policy deny returns deny_respond', () => {
    const policy: TrustPolicy = { default_policy: 'deny' };
    const result = evaluateTrust({ ...BASE_OPTS, trustPolicy: policy });
    expect(result).toEqual({ decision: 'deny_respond', reason: 'default_policy_deny' });
  });

  // ── 11. Default policy allow → allow ──────────────────────────────────

  it('default policy allow returns allow', () => {
    const policy: TrustPolicy = { default_policy: 'allow' };
    const result = evaluateTrust({ ...BASE_OPTS, trustPolicy: policy });
    expect(result).toEqual({ decision: 'allow', reason: 'default_policy_allow' });
  });

  // ── 12. DB error + deny policy → deny_respond (fail-closed) ───────────

  it('DB error with deny policy falls through to deny_respond', () => {
    const policy: TrustPolicy = { default_policy: 'deny' };
    const result = evaluateTrust({
      ...BASE_OPTS,
      trustPolicy: policy,
      senderTrustStore: throwingStore(),
    });
    expect(result).toEqual({ decision: 'deny_respond', reason: 'default_policy_deny' });
  });

  it('DB error with allow policy falls through to allow', () => {
    const policy: TrustPolicy = { default_policy: 'allow' };
    const result = evaluateTrust({
      ...BASE_OPTS,
      trustPolicy: policy,
      senderTrustStore: throwingStore(),
    });
    expect(result).toEqual({ decision: 'allow', reason: 'default_policy_allow' });
  });

  // ── 13. DB error + CLI → allow ────────────────────────────────────────

  it('DB error with CLI still returns allow (CLI bypass before DB)', () => {
    const policy: TrustPolicy = { default_policy: 'deny' };
    const result = evaluateTrust({
      channelType: 'cli',
      channelId: '',
      senderId: 'local',
      trustPolicy: policy,
      senderTrustStore: throwingStore(),
    });
    expect(result).toEqual({ decision: 'allow', reason: 'cli_bypass' });
  });

  // ── 14. Denylist + DB trusted → deny_silent (denylist wins) ────────────

  it('denylist wins over DB trusted (step 1 before step 2)', () => {
    const policy: TrustPolicy = {
      default_policy: 'allow',
      channels: { discord: { sender_denylist: ['user-1'] } },
    };
    const store = stubStore(makeRecord({ trustLevel: 'trusted' }));
    const result = evaluateTrust({ ...BASE_OPTS, trustPolicy: policy, senderTrustStore: store });
    expect(result).toEqual({ decision: 'deny_silent', reason: 'sender_denylist' });
  });

  // ── 15. Unknown channel type → falls through to default ────────────────

  it('unknown channel type with no channel config falls to default policy', () => {
    const policy: TrustPolicy = {
      default_policy: 'deny',
      channels: { discord: { policy: 'allow' } },
    };
    const result = evaluateTrust({
      channelType: 'telegram',
      channelId: 'some-chat',
      senderId: 'user-1',
      trustPolicy: policy,
    });
    expect(result).toEqual({ decision: 'deny_respond', reason: 'default_policy_deny' });
  });

  it('unknown channel type with allow default passes', () => {
    const policy: TrustPolicy = {
      default_policy: 'allow',
      channels: { discord: { policy: 'deny' } },
    };
    const result = evaluateTrust({
      channelType: 'slack',
      channelId: 'random',
      senderId: 'user-1',
      trustPolicy: policy,
    });
    expect(result).toEqual({ decision: 'allow', reason: 'default_policy_allow' });
  });

  // ── Precedence: DB trusted skips allowlist/overrides ───────────────────

  it('DB trusted stops evaluation before allowlist check', () => {
    const policy: TrustPolicy = {
      default_policy: 'deny',
      channels: { discord: { sender_allowlist: ['user-1'] } },
    };
    const store = stubStore(makeRecord({ trustLevel: 'trusted' }));
    const result = evaluateTrust({ ...BASE_OPTS, trustPolicy: policy, senderTrustStore: store });
    // DB trusted (step 2) wins over allowlist (step 3)
    expect(result).toEqual({ decision: 'allow', reason: 'db_trusted' });
  });

  // ── No senderTrustStore provided → skip DB step ───────────────────────

  it('no senderTrustStore skips DB step, falls through', () => {
    const policy: TrustPolicy = { default_policy: 'deny' };
    const result = evaluateTrust({ ...BASE_OPTS, trustPolicy: policy });
    expect(result).toEqual({ decision: 'deny_respond', reason: 'default_policy_deny' });
  });

  // ── DB returns record with unknown trust level → skip ─────────────────

  it('DB record with unrecognized trust level is skipped', () => {
    const policy: TrustPolicy = { default_policy: 'allow' };
    const store = stubStore(makeRecord({ trustLevel: 'pending' }));
    const result = evaluateTrust({ ...BASE_OPTS, trustPolicy: policy, senderTrustStore: store });
    expect(result).toEqual({ decision: 'allow', reason: 'default_policy_allow' });
  });

  // ── Full chain: all steps present, allowlist wins ─────────────────────

  it('full chain: sender not in denylist, no DB match, allowlist match', () => {
    const policy: TrustPolicy = {
      default_policy: 'deny',
      channels: {
        discord: {
          sender_denylist: ['bad-user'],
          sender_allowlist: ['user-1'],
          channel_overrides: { general: { policy: 'deny' } },
          policy: 'deny',
        },
      },
    };
    const store = stubStore(undefined); // no DB record
    const result = evaluateTrust({ ...BASE_OPTS, trustPolicy: policy, senderTrustStore: store });
    // allowlist (step 3) wins over channel override (step 4)
    expect(result).toEqual({ decision: 'allow', reason: 'sender_allowlist' });
  });

  // ── Channel config with no channels record ────────────────────────────

  it('trustPolicy with no channels record falls to default', () => {
    const policy: TrustPolicy = { default_policy: 'deny' };
    const result = evaluateTrust({ ...BASE_OPTS, trustPolicy: policy });
    expect(result).toEqual({ decision: 'deny_respond', reason: 'default_policy_deny' });
  });
});
