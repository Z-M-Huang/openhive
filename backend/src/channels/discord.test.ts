/**
 * Tests for Discord channel adapter.
 *
 * Uses mocked discord.js Client to test adapter behavior without connecting
 * to the actual Discord Gateway.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  Client,
  GatewayIntentBits,
  type Message as DiscordMessage,
} from 'discord.js';
import { DiscordAdapter } from './discord.js';
import { ChannelType } from '../domain/enums.js';
import type { InboundMessage } from '../domain/interfaces.js';

// Mock discord.js
vi.mock('discord.js', () => {
  const mockClient = {
    on: vi.fn(),
    login: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
    channels: {
      fetch: vi.fn(),
    },
  };

  return {
    Client: vi.fn(() => mockClient),
    GatewayIntentBits: {
      Guilds: 1 << 0,       // 1
      GuildMessages: 1 << 9, // 512
      MessageContent: 1 << 15, // 32768
    },
    Partials: {
      Channel: 0,
    },
  };
});

describe('DiscordAdapter', () => {
  let adapter: DiscordAdapter;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new DiscordAdapter();
    // Get the mocked client instance
    mockClient = new Client({ intents: [] });
  });

  afterEach(async () => {
    await adapter.disconnect();
  });

  describe('connect()', () => {
    it('creates Client with correct intents', async () => {
      process.env.DISCORD_BOT_TOKEN = 'test-token';

      await adapter.connect();

      expect(Client).toHaveBeenCalledWith({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
        ],
        partials: [0], // Partials.Channel
      });
      expect(mockClient.login).toHaveBeenCalledWith('test-token');

      delete process.env.DISCORD_BOT_TOKEN;
    });

    it('throws if DISCORD_BOT_TOKEN is not set', async () => {
      delete process.env.DISCORD_BOT_TOKEN;

      await expect(adapter.connect()).rejects.toThrow(
        'DISCORD_BOT_TOKEN environment variable is not set'
      );
    });
  });

  describe('messageCreate -> notifyHandlers()', () => {
    it('formats InboundMessage correctly and calls handlers', async () => {
      process.env.DISCORD_BOT_TOKEN = 'test-token';
      await adapter.connect();

      const receivedMessages: InboundMessage[] = [];
      adapter.onMessage(async (msg) => {
        receivedMessages.push(msg);
      });

      // Get the messageCreate handler that was registered
      const onCall = mockClient.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'messageCreate'
      );
      expect(onCall).toBeDefined();
      const messageHandler = onCall![1] as (msg: DiscordMessage) => Promise<void>;

      // Simulate a messageCreate event
      const mockDiscordMessage = {
        id: 'discord-msg-123',
        guildId: 'guild-456',
        channelId: 'channel-789',
        author: { bot: false },
        content: 'Hello, world!',
        createdTimestamp: 1234567890,
        channel: {
          isTextBased: () => true,
          sendTyping: vi.fn().mockResolvedValue(undefined),
        },
      } as unknown as DiscordMessage;

      await messageHandler(mockDiscordMessage);

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0]).toEqual({
        id: 'discord-msg-123',
        chatJid: 'discord:guild-456:channel-789',
        channelType: ChannelType.Discord,
        content: 'Hello, world!',
        timestamp: 1234567890,
      });
    });

    it('ignores bot messages', async () => {
      process.env.DISCORD_BOT_TOKEN = 'test-token';
      await adapter.connect();

      const receivedMessages: InboundMessage[] = [];
      adapter.onMessage(async (msg) => {
        receivedMessages.push(msg);
      });

      const onCall = mockClient.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'messageCreate'
      );
      const messageHandler = onCall![1] as (msg: DiscordMessage) => Promise<void>;

      // Simulate a bot message
      const mockBotMessage = {
        id: 'discord-msg-123',
        guildId: 'guild-456',
        channelId: 'channel-789',
        author: { bot: true },
        content: 'I am a bot',
        createdTimestamp: 1234567890,
        channel: {
          isTextBased: () => true,
          sendTyping: vi.fn().mockResolvedValue(undefined),
        },
      } as unknown as DiscordMessage;

      await messageHandler(mockBotMessage);

      expect(receivedMessages).toHaveLength(0);
    });

    it('strips Discord mentions from content', async () => {
      process.env.DISCORD_BOT_TOKEN = 'test-token';
      await adapter.connect();

      const receivedMessages: InboundMessage[] = [];
      adapter.onMessage(async (msg) => {
        receivedMessages.push(msg);
      });

      const onCall = mockClient.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'messageCreate'
      );
      const messageHandler = onCall![1] as (msg: DiscordMessage) => Promise<void>;

      // Message with various mention types
      const mockDiscordMessage = {
        id: 'discord-msg-123',
        guildId: 'guild-456',
        channelId: 'channel-789',
        author: { bot: false },
        content: '<@12345> <@!67890> <@&11111> <#22222> @everyone @here Hello!',
        createdTimestamp: 1234567890,
        channel: {
          isTextBased: () => true,
          sendTyping: vi.fn().mockResolvedValue(undefined),
        },
      } as unknown as DiscordMessage;

      await messageHandler(mockDiscordMessage);

      expect(receivedMessages[0].content).toBe('Hello!');
    });

    it('sends typing indicator on message receive (AC-L9-05)', async () => {
      process.env.DISCORD_BOT_TOKEN = 'test-token';
      await adapter.connect();

      const sendTyping = vi.fn().mockResolvedValue(undefined);
      adapter.onMessage(async () => {});

      const onCall = mockClient.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'messageCreate'
      );
      const messageHandler = onCall![1] as (msg: DiscordMessage) => Promise<void>;

      const mockDiscordMessage = {
        id: 'discord-msg-123',
        guildId: 'guild-456',
        channelId: 'channel-789',
        author: { bot: false },
        content: 'Hello',
        createdTimestamp: 1234567890,
        channel: {
          isTextBased: () => true,
          sendTyping,
        },
      } as unknown as DiscordMessage;

      await messageHandler(mockDiscordMessage);

      expect(sendTyping).toHaveBeenCalled();
    });
  });

  describe('sendMessage()', () => {
    it('sends a short message as single send', async () => {
      process.env.DISCORD_BOT_TOKEN = 'test-token';
      await adapter.connect();

      const mockSend = vi.fn().mockResolvedValue(undefined);
      mockClient.channels.fetch.mockResolvedValue({
        isTextBased: () => true,
        send: mockSend,
      });

      await adapter.sendMessage({
        chatJid: 'discord:guild-456:channel-789',
        content: 'Hello, world!',
      });

      expect(mockClient.channels.fetch).toHaveBeenCalledWith('channel-789');
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith('Hello, world!');
    });

    it('splits long message (>2000 chars) into multiple sends', async () => {
      process.env.DISCORD_BOT_TOKEN = 'test-token';
      await adapter.connect();

      const mockSend = vi.fn().mockResolvedValue(undefined);
      mockClient.channels.fetch.mockResolvedValue({
        isTextBased: () => true,
        send: mockSend,
      });

      // Create a 5000-character message
      const longContent = 'a'.repeat(5000);

      await adapter.sendMessage({
        chatJid: 'discord:guild-456:channel-789',
        content: longContent,
      });

      // Should split into 3 chunks: 2000 + 2000 + 1000
      expect(mockSend).toHaveBeenCalledTimes(3);
      expect(mockSend).toHaveBeenNthCalledWith(1, 'a'.repeat(2000));
      expect(mockSend).toHaveBeenNthCalledWith(2, 'a'.repeat(2000));
      expect(mockSend).toHaveBeenNthCalledWith(3, 'a'.repeat(1000));
    });

    it('splits message at newline boundaries when possible', async () => {
      process.env.DISCORD_BOT_TOKEN = 'test-token';
      await adapter.connect();

      const mockSend = vi.fn().mockResolvedValue(undefined);
      mockClient.channels.fetch.mockResolvedValue({
        isTextBased: () => true,
        send: mockSend,
      });

      // Create a message where there's a newline near the 2000 boundary
      const content = 'a'.repeat(1995) + '\n' + 'b'.repeat(100);

      await adapter.sendMessage({
        chatJid: 'discord:guild-456:channel-789',
        content,
      });

      expect(mockSend).toHaveBeenCalledTimes(2);
      // First chunk should include the newline
      expect(mockSend).toHaveBeenNthCalledWith(1, 'a'.repeat(1995) + '\n');
      expect(mockSend).toHaveBeenNthCalledWith(2, 'b'.repeat(100));
    });

    it('throws if client is not connected', async () => {
      await expect(
        adapter.sendMessage({
          chatJid: 'discord:guild-456:channel-789',
          content: 'Hello',
        })
      ).rejects.toThrow('Discord client is not connected');
    });

    it('throws if channel is not found', async () => {
      process.env.DISCORD_BOT_TOKEN = 'test-token';
      await adapter.connect();

      mockClient.channels.fetch.mockResolvedValue(null);

      await expect(
        adapter.sendMessage({
          chatJid: 'discord:guild-456:channel-789',
          content: 'Hello',
        })
      ).rejects.toThrow('Discord channel not found: channel-789');
    });

    it('throws if channel is not text-based', async () => {
      process.env.DISCORD_BOT_TOKEN = 'test-token';
      await adapter.connect();

      mockClient.channels.fetch.mockResolvedValue({
        isTextBased: () => false,
      });

      await expect(
        adapter.sendMessage({
          chatJid: 'discord:guild-456:channel-789',
          content: 'Hello',
        })
      ).rejects.toThrow('Discord channel is not text-based: channel-789');
    });

    it('throws for invalid chatJid format', async () => {
      process.env.DISCORD_BOT_TOKEN = 'test-token';
      await adapter.connect();

      await expect(
        adapter.sendMessage({
          chatJid: 'invalid-format',
          content: 'Hello',
        })
      ).rejects.toThrow('Invalid chatJid format');
    });
  });

  describe('disconnect()', () => {
    it('destroys the client', async () => {
      process.env.DISCORD_BOT_TOKEN = 'test-token';
      await adapter.connect();

      await adapter.disconnect();

      expect(mockClient.destroy).toHaveBeenCalled();
    });

    it('is idempotent — safe to call when not connected', async () => {
      // Should not throw
      await adapter.disconnect();
      await adapter.disconnect();
    });
  });

  describe('chatJid parsing', () => {
    it('handles DM channels (no guildId)', async () => {
      process.env.DISCORD_BOT_TOKEN = 'test-token';
      await adapter.connect();

      const receivedMessages: InboundMessage[] = [];
      adapter.onMessage(async (msg) => {
        receivedMessages.push(msg);
      });

      const onCall = mockClient.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'messageCreate'
      );
      const messageHandler = onCall![1] as (msg: DiscordMessage) => Promise<void>;

      // DM message (no guild)
      const mockDiscordMessage = {
        id: 'discord-msg-123',
        guildId: null,
        channelId: 'dm-channel-789',
        author: { bot: false },
        content: 'Hello',
        createdTimestamp: 1234567890,
        channel: {
          isTextBased: () => true,
          sendTyping: vi.fn().mockResolvedValue(undefined),
        },
      } as unknown as DiscordMessage;

      await messageHandler(mockDiscordMessage);

      expect(receivedMessages[0].chatJid).toBe('discord:dm:dm-channel-789');
    });
  });
});