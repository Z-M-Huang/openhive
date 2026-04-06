/**
 * Trust policy schema tests.
 *
 * Validates TrustPolicySchema parsing, defaults, and error paths.
 */

import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import { TrustPolicySchema, ChannelTrustSchema } from './trust-policy.js';
import { ChannelsSchema } from './validation.js';

// ── TrustPolicySchema ─────────────────────────────────────────────────────

describe('TrustPolicySchema', () => {
  it('accepts a full trust config', () => {
    const result = TrustPolicySchema.parse({
      default_policy: 'deny',
      channels: {
        discord: {
          policy: 'allow',
          sender_allowlist: ['user-123', 'user-456'],
          sender_denylist: ['spammer-789'],
          channel_overrides: {
            'general': { policy: 'deny' },
          },
        },
      },
    });
    expect(result.default_policy).toBe('deny');
    expect(result.channels?.discord?.policy).toBe('allow');
    expect(result.channels?.discord?.sender_allowlist).toEqual(['user-123', 'user-456']);
    expect(result.channels?.discord?.sender_denylist).toEqual(['spammer-789']);
    expect(result.channels?.discord?.channel_overrides?.general?.policy).toBe('deny');
  });

  it('defaults default_policy to allow when omitted', () => {
    const result = TrustPolicySchema.parse({});
    expect(result.default_policy).toBe('allow');
    expect(result.channels).toBeUndefined();
  });

  it('accepts minimal config with only default_policy', () => {
    const result = TrustPolicySchema.parse({ default_policy: 'deny' });
    expect(result.default_policy).toBe('deny');
    expect(result.channels).toBeUndefined();
  });

  it('rejects invalid default_policy value', () => {
    expect(() => TrustPolicySchema.parse({ default_policy: 'maybe' })).toThrow(ZodError);
  });

  it('accepts channels with empty config', () => {
    const result = TrustPolicySchema.parse({
      channels: { discord: {} },
    });
    expect(result.channels?.discord?.policy).toBeUndefined();
    expect(result.channels?.discord?.sender_allowlist).toBeUndefined();
  });
});

// ── ChannelTrustSchema ────────────────────────────────────────────────────

describe('ChannelTrustSchema', () => {
  it('accepts empty object (all fields optional)', () => {
    const result = ChannelTrustSchema.parse({});
    expect(result.policy).toBeUndefined();
    expect(result.sender_allowlist).toBeUndefined();
    expect(result.sender_denylist).toBeUndefined();
    expect(result.channel_overrides).toBeUndefined();
  });

  it('rejects invalid policy value', () => {
    expect(() => ChannelTrustSchema.parse({ policy: 'block' })).toThrow(ZodError);
  });

  it('rejects non-string items in sender_allowlist', () => {
    expect(() => ChannelTrustSchema.parse({ sender_allowlist: [123] })).toThrow(ZodError);
  });

  it('rejects invalid channel_overrides policy', () => {
    expect(() =>
      ChannelTrustSchema.parse({
        channel_overrides: { general: { policy: 'maybe' } },
      }),
    ).toThrow(ZodError);
  });
});

// ── ChannelsSchema backward compatibility ─────────────────────────────────

describe('ChannelsSchema trust integration', () => {
  it('accepts channels config without trust section (backward compat)', () => {
    const result = ChannelsSchema.parse({});
    expect(result.trust).toBeUndefined();
    expect(result.cli.enabled).toBe(true);
  });

  it('accepts channels config with trust section', () => {
    const result = ChannelsSchema.parse({
      trust: {
        default_policy: 'deny',
        channels: {
          discord: {
            policy: 'allow',
            sender_allowlist: ['admin-1'],
          },
        },
      },
    });
    const trust = result.trust;
    expect(trust).toBeDefined();
    expect(trust!.default_policy).toBe('deny');
    expect(trust!.channels?.discord?.sender_allowlist).toEqual(['admin-1']);
  });

  it('rejects channels config with invalid trust section', () => {
    expect(() =>
      ChannelsSchema.parse({
        trust: { default_policy: 'invalid' },
      }),
    ).toThrow(ZodError);
  });
});
