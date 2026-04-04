/**
 * Channel handler factory tests.
 *
 * 1. First message with no topics -> creates topic, passes topicId to handleMessage
 * 2. Explicit topicHint -> bypasses classifier, routes directly
 * 3. topicId passed through to handleMessage opts
 * 4. Interaction records include topicId
 * 5. 5 active topics + new message -> rejects with active topic list
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createChannelHandler, type ChannelHandlerDeps } from './channel-handler-factory.js';
import type { ChannelMessage, IInteractionStore, ITopicStore, InteractionRecord } from './domain/interfaces.js';
import type { TopicEntry } from './domain/types.js';

// ── Mock handleMessage ────────────────────────────────────────────────────

const mockHandleMessage = vi.fn().mockResolvedValue({ ok: true, content: 'Hello' });
vi.mock('./sessions/message-handler.js', () => ({
  handleMessage: (...args: unknown[]) => mockHandleMessage(...args),
}));

// ── Mock classifyTopic ────────────────────────────────────────────────────

const mockClassifyTopic = vi.fn();
vi.mock('./sessions/topic-classifier.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./sessions/topic-classifier.js')>();
  return {
    ...orig,
    classifyTopic: (...args: unknown[]) => mockClassifyTopic(...args),
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
    expect(result.topicId).toBe(created.id);
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

    expect(result.topicId).toBe('t-abc');
    expect(result.topicName).toBe('Billing');
    expect(mockClassifyTopic).not.toHaveBeenCalled();
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

  it('includes topicId in interaction records', async () => {
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
    mockClassifyTopic.mockResolvedValue({ topicId: null, topicName: 'New', confidence: 0.8 });

    const handler = createChannelHandler({
      handlerDeps: stubHandlerDeps, triggerEngine: stubTriggerEngine,
      topicStore: store, classifierModel: {} as ChannelHandlerDeps['classifierModel'],
    });

    const result = await handler(makeMsg());

    expect(result.response).toContain('Max 5 active topics');
    expect(result.response).toContain('Topic 0');
    expect(result.response).toContain('Topic 4');
    expect(store.create).not.toHaveBeenCalled();
  });
});
