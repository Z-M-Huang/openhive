/**
 * Trust tool handler tests — add_trusted_sender, revoke_sender_trust, list_trusted_senders.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { ISenderTrustStore, SenderTrustRecord } from '../../domain/interfaces.js';
import { addTrustedSender } from './add-trusted-sender.js';
import { revokeSenderTrust } from './revoke-sender-trust.js';
import { listTrustedSenders } from './list-trusted-senders.js';

// ── In-memory ISenderTrustStore mock ─────────────────────────────────────

function createMockSenderTrustStore(): ISenderTrustStore & { records: SenderTrustRecord[] } {
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

// ── add_trusted_sender ───────────────────────────────────────────────────

describe('add_trusted_sender', () => {
  let store: ReturnType<typeof createMockSenderTrustStore>;

  beforeEach(() => {
    store = createMockSenderTrustStore();
  });

  it('adds a trust record with defaults', () => {
    const result = addTrustedSender(
      { channel_type: 'discord', sender_id: 'user-1' },
      'admin',
      { senderTrustStore: store },
    );

    expect(result).toEqual({ success: true });
    expect(store.records).toHaveLength(1);
    expect(store.records[0]).toEqual(
      expect.objectContaining({
        channelType: 'discord',
        senderId: 'user-1',
        trustLevel: 'trusted',
        grantedBy: 'admin',
      }),
    );
    expect(store.records[0].createdAt).toBeTruthy();
  });

  it('accepts explicit trust_level and channel_id', () => {
    const result = addTrustedSender(
      { channel_type: 'slack', sender_id: 'user-2', channel_id: 'ch-99', trust_level: 'elevated' },
      'admin',
      { senderTrustStore: store },
    );

    expect(result).toEqual({ success: true });
    expect(store.records[0]).toEqual(
      expect.objectContaining({
        channelType: 'slack',
        senderId: 'user-2',
        channelId: 'ch-99',
        trustLevel: 'elevated',
      }),
    );
  });

  it('rejects invalid input (missing channel_type)', () => {
    const result = addTrustedSender(
      { sender_id: 'user-1' },
      'admin',
      { senderTrustStore: store },
    );

    expect(result.success).toBe(false);
    expect(result.reason).toContain('invalid input');
    expect(store.records).toHaveLength(0);
  });

  it('rejects invalid input (empty sender_id)', () => {
    const result = addTrustedSender(
      { channel_type: 'discord', sender_id: '' },
      'admin',
      { senderTrustStore: store },
    );

    expect(result.success).toBe(false);
    expect(result.reason).toContain('invalid input');
  });
});

// ── revoke_sender_trust ──────────────────────────────────────────────────

describe('revoke_sender_trust', () => {
  let store: ReturnType<typeof createMockSenderTrustStore>;

  beforeEach(() => {
    store = createMockSenderTrustStore();
    store.add({
      channelType: 'discord',
      senderId: 'user-1',
      trustLevel: 'trusted',
      grantedBy: 'admin',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('removes an existing trust record', () => {
    const result = revokeSenderTrust(
      { channel_type: 'discord', sender_id: 'user-1' },
      'admin',
      { senderTrustStore: store },
    );

    expect(result).toEqual({ success: true });
    expect(store.records).toHaveLength(0);
  });

  it('removes record with matching channel_id', () => {
    store.add({
      channelType: 'slack',
      senderId: 'user-2',
      channelId: 'ch-5',
      trustLevel: 'trusted',
      grantedBy: 'admin',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const result = revokeSenderTrust(
      { channel_type: 'slack', sender_id: 'user-2', channel_id: 'ch-5' },
      'admin',
      { senderTrustStore: store },
    );

    expect(result).toEqual({ success: true });
    // Original discord record still present
    expect(store.records).toHaveLength(1);
    expect(store.records[0].channelType).toBe('discord');
  });

  it('succeeds even when no matching record exists', () => {
    const result = revokeSenderTrust(
      { channel_type: 'discord', sender_id: 'nonexistent' },
      'admin',
      { senderTrustStore: store },
    );

    expect(result).toEqual({ success: true });
    // Original record untouched
    expect(store.records).toHaveLength(1);
  });

  it('rejects invalid input (missing sender_id)', () => {
    const result = revokeSenderTrust(
      { channel_type: 'discord' },
      'admin',
      { senderTrustStore: store },
    );

    expect(result.success).toBe(false);
    expect(result.reason).toContain('invalid input');
  });
});

// ── list_trusted_senders ─────────────────────────────────────────────────

describe('list_trusted_senders', () => {
  let store: ReturnType<typeof createMockSenderTrustStore>;

  beforeEach(() => {
    store = createMockSenderTrustStore();
    store.add({
      channelType: 'discord',
      senderId: 'user-1',
      trustLevel: 'trusted',
      grantedBy: 'admin',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    store.add({
      channelType: 'slack',
      senderId: 'user-2',
      trustLevel: 'elevated',
      grantedBy: 'admin',
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    store.add({
      channelType: 'discord',
      senderId: 'user-3',
      trustLevel: 'elevated',
      grantedBy: 'admin',
      createdAt: '2026-01-03T00:00:00.000Z',
    });
  });

  it('lists all senders when no filters', () => {
    const result = listTrustedSenders(
      {},
      'admin',
      { senderTrustStore: store },
    );

    expect(result.success).toBe(true);
    expect(result.senders).toHaveLength(3);
  });

  it('filters by channel_type', () => {
    const result = listTrustedSenders(
      { channel_type: 'discord' },
      'admin',
      { senderTrustStore: store },
    );

    expect(result.success).toBe(true);
    expect(result.senders).toHaveLength(2);
    expect(result.senders!.every((s) => s.channelType === 'discord')).toBe(true);
  });

  it('filters by trust_level', () => {
    const result = listTrustedSenders(
      { trust_level: 'elevated' },
      'admin',
      { senderTrustStore: store },
    );

    expect(result.success).toBe(true);
    expect(result.senders).toHaveLength(2);
    expect(result.senders!.every((s) => s.trustLevel === 'elevated')).toBe(true);
  });

  it('filters by both channel_type and trust_level', () => {
    const result = listTrustedSenders(
      { channel_type: 'discord', trust_level: 'elevated' },
      'admin',
      { senderTrustStore: store },
    );

    expect(result.success).toBe(true);
    expect(result.senders).toHaveLength(1);
    expect(result.senders![0].senderId).toBe('user-3');
  });

  it('returns empty array when no matches', () => {
    const result = listTrustedSenders(
      { channel_type: 'telegram' },
      'admin',
      { senderTrustStore: store },
    );

    expect(result.success).toBe(true);
    expect(result.senders).toHaveLength(0);
  });
});
