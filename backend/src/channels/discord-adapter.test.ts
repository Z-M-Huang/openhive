/**
 * UT-20: Discord Adapter
 *
 * Tests: Discord adapter instantiates with mocked Client.
 * Verifies onMessage callback registered, bot messages ignored,
 * channel filtering, typing indicators.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

import { DiscordAdapter, type DiscordClient } from './discord-adapter.js';
import { SecretString } from '../secrets/secret-string.js';
import type { ChannelMessage } from '../domain/interfaces.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Wait for the event loop to flush micro/macrotasks. */
function flush(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Build a mock discord.js Client for testing. */
function createMockDiscordClient(): DiscordClient & EventEmitter & {
  login: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  channels: { fetch: ReturnType<typeof vi.fn> };
} {
  const emitter = new EventEmitter();
  const mock = Object.assign(emitter, {
    login: vi.fn<(token: string) => Promise<string>>().mockResolvedValue('token'),
    destroy: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    channels: {
      fetch: vi.fn<(id: string) => Promise<unknown>>().mockResolvedValue(null),
    },
  });
  return mock;
}

// ── UT-20: Discord Adapter ─────────────────────────────────────────────────

describe('UT-20: Discord Adapter', () => {
  let mockClient: ReturnType<typeof createMockDiscordClient>;
  let token: SecretString;

  beforeEach(() => {
    mockClient = createMockDiscordClient();
    token = new SecretString('test-bot-token');
  });

  it('instantiates with mocked client', () => {
    const adapter = new DiscordAdapter({
      token,
      client: mockClient,
    });
    expect(adapter).toBeDefined();
  });

  it('connect does not call login when client is injected', async () => {
    const adapter = new DiscordAdapter({
      token,
      client: mockClient,
    });
    await adapter.connect();
    expect(mockClient.login).not.toHaveBeenCalled();
  });

  it('disconnect does not call destroy when client is injected', async () => {
    const adapter = new DiscordAdapter({
      token,
      client: mockClient,
    });
    await adapter.disconnect();
    expect(mockClient.destroy).not.toHaveBeenCalled();
  });

  it('receives messages and calls handler', async () => {
    const adapter = new DiscordAdapter({
      token,
      client: mockClient,
    });

    const messages: ChannelMessage[] = [];
    adapter.onMessage(async (msg) => {
      messages.push(msg);
    });

    // Simulate a Discord message event
    mockClient.emit('messageCreate', {
      author: { bot: false, id: 'user-1' },
      channelId: 'chan-123',
      content: 'hello from discord',
      createdTimestamp: 1700000000000,
      channel: { sendTyping: vi.fn().mockResolvedValue(undefined) },
    });

    await flush();

    expect(messages).toHaveLength(1);
    expect(messages[0].channelId).toBe('chan-123');
    expect(messages[0].userId).toBe('user-1');
    expect(messages[0].content).toBe('hello from discord');
    expect(messages[0].timestamp).toBe(1700000000000);
  });

  it('ignores bot messages', async () => {
    const adapter = new DiscordAdapter({
      token,
      client: mockClient,
    });

    const messages: ChannelMessage[] = [];
    adapter.onMessage(async (msg) => {
      messages.push(msg);
    });

    mockClient.emit('messageCreate', {
      author: { bot: true, id: 'bot-1' },
      channelId: 'chan-123',
      content: 'bot says hi',
      createdTimestamp: 1700000000000,
      channel: {},
    });

    await flush();
    expect(messages).toHaveLength(0);
  });

  it('filters to watched channels', async () => {
    const adapter = new DiscordAdapter({
      token,
      watchedChannelIds: ['chan-allowed'],
      client: mockClient,
    });

    const messages: ChannelMessage[] = [];
    adapter.onMessage(async (msg) => {
      messages.push(msg);
    });

    // Message in unwatched channel
    mockClient.emit('messageCreate', {
      author: { bot: false, id: 'user-1' },
      channelId: 'chan-ignored',
      content: 'should be filtered',
      createdTimestamp: 1700000000000,
      channel: {},
    });

    // Message in watched channel
    mockClient.emit('messageCreate', {
      author: { bot: false, id: 'user-1' },
      channelId: 'chan-allowed',
      content: 'should pass',
      createdTimestamp: 1700000000001,
      channel: { sendTyping: vi.fn().mockResolvedValue(undefined) },
    });

    await flush();

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('should pass');
  });

  it('shows typing indicator', async () => {
    const adapter = new DiscordAdapter({
      token,
      client: mockClient,
    });

    adapter.onMessage(async () => {
      /* no-op */
    });

    const sendTyping = vi.fn().mockResolvedValue(undefined);
    mockClient.emit('messageCreate', {
      author: { bot: false, id: 'user-1' },
      channelId: 'chan-123',
      content: 'trigger typing',
      createdTimestamp: 1700000000000,
      channel: { sendTyping },
    });

    await flush();
    expect(sendTyping).toHaveBeenCalledTimes(1);
  });

  it('sendResponse fetches channel and sends', async () => {
    const mockSend = vi.fn().mockResolvedValue(undefined);
    mockClient.channels.fetch.mockResolvedValue({ send: mockSend });

    const adapter = new DiscordAdapter({
      token,
      client: mockClient,
    });

    await adapter.sendResponse('chan-123', 'hello back');

    expect(mockClient.channels.fetch).toHaveBeenCalledWith('chan-123');
    expect(mockSend).toHaveBeenCalledWith('hello back');
  });

  it('sendResponse handles null channel gracefully', async () => {
    mockClient.channels.fetch.mockResolvedValue(null);

    const adapter = new DiscordAdapter({
      token,
      client: mockClient,
    });

    // Should not throw
    await adapter.sendResponse('nonexistent', 'hello');
  });
});
