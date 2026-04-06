/**
 * Channel handler factory tests.
 *
 * 1. First message with no topics -> creates topic, passes topicId to handleMessage
 * 2. Explicit topicHint -> bypasses classifier, routes directly
 * 3. topicId passed through to handleMessage opts
 * 4. Interaction records include topicId
 * 5. 5 active topics + new message -> rejects with active topic list
 * 6. Multi-topic: LLM returns 2 topicIds -> 2 results
 * 7. Multi-topic: one topic errors, others succeed
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createChannelHandler, type ChannelHandlerDeps } from './channel-handler-factory.js';
import type { ChannelMessage, IInteractionStore, ITopicStore, InteractionRecord, ITrustAuditStore, TrustAuditEntry } from './domain/interfaces.js';
import type { TopicEntry } from './domain/types.js';
import type { TrustEvalResult } from './trust/trust-gate.js';

// ── Mock handleMessage ────────────────────────────────────────────────────

const mockHandleMessage = vi.fn().mockResolvedValue({ ok: true, content: 'Hello' });
vi.mock('./sessions/message-handler.js', () => ({
  handleMessage: (...args: unknown[]) => mockHandleMessage(...args),
}));

// ── Mock evaluateTrust ──────────────────────────────────────────────────

const mockEvaluateTrust = vi.fn().mockReturnValue({ decision: 'allow', reason: 'no_trust_config' } satisfies TrustEvalResult);
vi.mock('./trust/trust-gate.js', () => ({
  evaluateTrust: (...args: unknown[]) => mockEvaluateTrust(...(args as [])),
}));

// ── Mock classifyTopics ─────────────────────────────────────────────────

const mockClassifyTopics = vi.fn();
vi.mock('./sessions/topic-classifier.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./sessions/topic-classifier.js')>();
  return {
    ...orig,
    classifyTopics: (...args: unknown[]) => mockClassifyTopics(...args),
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────

function makeMsg(overrides?: Partial<ChannelMessage>): ChannelMessage {
  return { channelId: 'ws:test', userId: 'u1', content: 'hi', timestamp: Date.now(), ...overrides };
}

function makeTopicStore(active: TopicEntry[] = [], idle: TopicEntry[] = []): ITopicStore {
  return {
    create: vi.fn(),
    getById: vi.fn(),
    getByChannel: vi.fn().mockReturnValue([...active, ...idle]),
    getActiveByChannel: vi.fn().mockReturnValue(active),
    getIdleByChannel: vi.fn().mockReturnValue(idle),
    updateState: vi.fn(),
    touchActivity: vi.fn(),
    markAllIdle: vi.fn().mockReturnValue(0),
  };
}

function makeInteractionStore(): IInteractionStore & { logged: InteractionRecord[] } {
  const logged: InteractionRecord[] = [];
  return {
    logged,
    log: vi.fn((r: InteractionRecord) => logged.push(r)),
    getRecentByChannel: vi.fn().mockReturnValue([]),
    cleanOlderThan: vi.fn().mockReturnValue(0),
    removeByTeam: vi.fn(),
  };
}

function makeTrustAuditStore(): ITrustAuditStore & { logged: TrustAuditEntry[] } {
  const logged: TrustAuditEntry[] = [];
  return {
    logged,
    log: vi.fn((e: TrustAuditEntry) => logged.push(e)),
    query: vi.fn().mockReturnValue([]),
  };
}

const stubTriggerEngine = { onMessage: vi.fn() };
const stubHandlerDeps = {} as NonNullable<ChannelHandlerDeps['handlerDeps']>;

// ── Tests ─────────────────────────────────────────────────────────────────

describe('createChannelHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHandleMessage.mockResolvedValue({ ok: true, content: 'Hello' });
  });

  it('creates topic on first message with no existing topics', async () => {
    const store = makeTopicStore();
    const handler = createChannelHandler({
      handlerDeps: stubHandlerDeps, triggerEngine: stubTriggerEngine,
      topicStore: store,
    });

    const result = await handler(makeMsg());

    expect(store.create).toHaveBeenCalledOnce();
    const created = (store.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as TopicEntry;
    expect(created.id).toMatch(/^t-[0-9a-f]{16}$/);
    expect(created.state).toBe('active');
    expect(result.results[0].topicId).toBe(created.id);
  });

  it('routes by topicHint without calling classifier', async () => {
    const existing: TopicEntry = {
      id: 't-abc', channelId: 'ws:test', name: 'Billing',
      description: '', state: 'active', createdAt: '', lastActivity: '',
    };
    const store = makeTopicStore([existing]);
    const handler = createChannelHandler({
      handlerDeps: stubHandlerDeps, triggerEngine: stubTriggerEngine,
      topicStore: store,
    });

    const result = await handler(makeMsg({ topicHint: 'billing' }));

    expect(result.results[0].topicId).toBe('t-abc');
    expect(result.results[0].topicName).toBe('Billing');
    expect(mockClassifyTopics).not.toHaveBeenCalled();
    expect(store.touchActivity).toHaveBeenCalledWith('t-abc');
  });

  it('passes topicId and topicName to handleMessage opts', async () => {
    const store = makeTopicStore();
    const handler = createChannelHandler({
      handlerDeps: stubHandlerDeps, triggerEngine: stubTriggerEngine,
      topicStore: store,
    });

    await handler(makeMsg());

    expect(mockHandleMessage).toHaveBeenCalledOnce();
    const opts = mockHandleMessage.mock.calls[0][2] as Record<string, unknown>;
    expect(opts.topicId).toMatch(/^t-[0-9a-f]{16}$/);
    expect(opts.topicName).toBe('New topic');
  });

  it('includes topicId in interaction records (per-topic)', async () => {
    const topicStore = makeTopicStore();
    const interactionStore = makeInteractionStore();
    const handler = createChannelHandler({
      handlerDeps: stubHandlerDeps, triggerEngine: stubTriggerEngine,
      topicStore, interactionStore,
    });

    await handler(makeMsg());

    expect(interactionStore.logged.length).toBe(2); // inbound + outbound
    for (const record of interactionStore.logged) {
      expect(record.topicId).toMatch(/^t-[0-9a-f]{16}$/);
    }
  });

  it('rejects when 5 active topics and classifier says new', async () => {
    const active: TopicEntry[] = Array.from({ length: 5 }, (_, i) => ({
      id: `t-${i}`, channelId: 'ws:test', name: `Topic ${i}`,
      description: '', state: 'active' as const, createdAt: '', lastActivity: '',
    }));
    const store = makeTopicStore(active);
    mockClassifyTopics.mockResolvedValue({ matches: [{ topicId: null, topicName: 'New', confidence: 0.8 }] });

    const handler = createChannelHandler({
      handlerDeps: stubHandlerDeps, triggerEngine: stubTriggerEngine,
      topicStore: store, classifierModel: {} as ChannelHandlerDeps['classifierModel'],
    });

    const result = await handler(makeMsg());

    expect(result.results[0].response).toContain('Max 5 active topics');
    expect(result.results[0].response).toContain('Topic 0');
    expect(result.results[0].response).toContain('Topic 4');
    expect(store.create).not.toHaveBeenCalled();
  });

  it('returns multiple results when classifier matches 2 topics', async () => {
    const active: TopicEntry[] = [
      { id: 't-1', channelId: 'ws:test', name: 'Auth', description: '', state: 'active', createdAt: '', lastActivity: '' },
      { id: 't-2', channelId: 'ws:test', name: 'Deploy', description: '', state: 'active', createdAt: '', lastActivity: '' },
    ];
    const store = makeTopicStore(active);
    mockClassifyTopics.mockResolvedValue({ matches: [{ topicId: 't-1', confidence: 0.9 }, { topicId: 't-2', confidence: 0.9 }] });
    mockHandleMessage
      .mockResolvedValueOnce({ ok: true, content: 'Auth reply' })
      .mockResolvedValueOnce({ ok: true, content: 'Deploy reply' });

    const handler = createChannelHandler({
      handlerDeps: stubHandlerDeps, triggerEngine: stubTriggerEngine,
      topicStore: store, classifierModel: {} as ChannelHandlerDeps['classifierModel'],
    });

    const result = await handler(makeMsg({ content: 'how does auth affect deploy?' }));

    expect(result.results).toHaveLength(2);
    expect(result.results[0].response).toBe('Auth reply');
    expect(result.results[0].topicId).toBe('t-1');
    expect(result.results[1].response).toBe('Deploy reply');
    expect(result.results[1].topicId).toBe('t-2');
    expect(mockHandleMessage).toHaveBeenCalledTimes(2);
  });

  it('isolates failures — one topic error does not affect others', async () => {
    const active: TopicEntry[] = [
      { id: 't-1', channelId: 'ws:test', name: 'Auth', description: '', state: 'active', createdAt: '', lastActivity: '' },
      { id: 't-2', channelId: 'ws:test', name: 'Deploy', description: '', state: 'active', createdAt: '', lastActivity: '' },
    ];
    const store = makeTopicStore(active);
    mockClassifyTopics.mockResolvedValue({ matches: [{ topicId: 't-1', confidence: 0.9 }, { topicId: 't-2', confidence: 0.9 }] });
    mockHandleMessage
      .mockRejectedValueOnce(new Error('Auth service down'))
      .mockResolvedValueOnce({ ok: true, content: 'Deploy reply' });

    const handler = createChannelHandler({
      handlerDeps: stubHandlerDeps, triggerEngine: stubTriggerEngine,
      topicStore: store, classifierModel: {} as ChannelHandlerDeps['classifierModel'],
    });

    const result = await handler(makeMsg({ content: 'check both' }));

    expect(result.results).toHaveLength(2);
    expect(result.results[0].response).toContain('Auth service down');
    expect(result.results[1].response).toBe('Deploy reply');
  });

  // ── TrustGate integration tests ─────────────────────────────────────────

  describe('TrustGate integration', () => {
    it('deny_silent returns empty results and skips trigger engine', async () => {
      mockEvaluateTrust.mockReturnValue({ decision: 'deny_silent', reason: 'sender_denylist' });
      const auditStore = makeTrustAuditStore();
      const interactionStore = makeInteractionStore();

      const handler = createChannelHandler({
        handlerDeps: stubHandlerDeps, triggerEngine: stubTriggerEngine,
        trustPolicy: { default_policy: 'deny' }, trustAuditStore: auditStore,
        interactionStore,
      });

      const result = await handler(makeMsg());

      expect(result.results).toHaveLength(0);
      expect(stubTriggerEngine.onMessage).not.toHaveBeenCalled();
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });

    it('deny_respond returns "Not authorized." and skips trigger engine', async () => {
      mockEvaluateTrust.mockReturnValue({ decision: 'deny_respond', reason: 'default_policy_deny' });
      const auditStore = makeTrustAuditStore();
      const interactionStore = makeInteractionStore();

      const handler = createChannelHandler({
        handlerDeps: stubHandlerDeps, triggerEngine: stubTriggerEngine,
        trustPolicy: { default_policy: 'deny' }, trustAuditStore: auditStore,
        interactionStore,
      });

      const result = await handler(makeMsg());

      expect(result.results).toHaveLength(1);
      expect(result.results[0].response).toBe('Not authorized.');
      expect(stubTriggerEngine.onMessage).not.toHaveBeenCalled();
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });

    it('logs to trustAuditStore on deny', async () => {
      mockEvaluateTrust.mockReturnValue({ decision: 'deny_silent', reason: 'sender_denylist' });
      const auditStore = makeTrustAuditStore();

      const handler = createChannelHandler({
        handlerDeps: stubHandlerDeps, triggerEngine: stubTriggerEngine,
        trustPolicy: { default_policy: 'deny' }, trustAuditStore: auditStore,
      });

      await handler(makeMsg({ channelId: 'ws:ch1', userId: 'bad-user' }));

      expect(auditStore.logged).toHaveLength(1);
      expect(auditStore.logged[0].decision).toBe('denied');
      expect(auditStore.logged[0].reason).toBe('sender_denylist');
      expect(auditStore.logged[0].senderId).toBe('bad-user');
      expect(auditStore.logged[0].channelType).toBe('ws');
    });

    it('logs to interactionStore with trustDecision on deny', async () => {
      mockEvaluateTrust.mockReturnValue({ decision: 'deny_respond', reason: 'default_policy_deny' });
      const interactionStore = makeInteractionStore();

      const handler = createChannelHandler({
        handlerDeps: stubHandlerDeps, triggerEngine: stubTriggerEngine,
        trustPolicy: { default_policy: 'deny' }, interactionStore,
      });

      await handler(makeMsg());

      expect(interactionStore.logged).toHaveLength(1);
      expect(interactionStore.logged[0].direction).toBe('inbound');
      expect(interactionStore.logged[0].trustDecision).toBe('denied');
    });

    it('logs to trustAuditStore on allow', async () => {
      mockEvaluateTrust.mockReturnValue({ decision: 'allow', reason: 'sender_allowlist' });
      const auditStore = makeTrustAuditStore();

      const handler = createChannelHandler({
        handlerDeps: stubHandlerDeps, triggerEngine: stubTriggerEngine,
        trustPolicy: { default_policy: 'allow' }, trustAuditStore: auditStore,
      });

      await handler(makeMsg());

      expect(auditStore.logged).toHaveLength(1);
      expect(auditStore.logged[0].decision).toBe('allowed');
      expect(auditStore.logged[0].reason).toBe('sender_allowlist');
    });

    it('proceeds normally when no trustPolicy is configured (backward compat)', async () => {
      mockEvaluateTrust.mockReturnValue({ decision: 'allow', reason: 'no_trust_config' });
      const store = makeTopicStore();

      const handler = createChannelHandler({
        handlerDeps: stubHandlerDeps, triggerEngine: stubTriggerEngine,
        topicStore: store,
        // no trustPolicy, no senderTrustStore, no trustAuditStore
      });

      const result = await handler(makeMsg());

      expect(stubTriggerEngine.onMessage).toHaveBeenCalledOnce();
      expect(mockHandleMessage).toHaveBeenCalledOnce();
      expect(result.results[0].response).toBe('Hello');
    });
  });
});
