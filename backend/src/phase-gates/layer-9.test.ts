/**
 * Layer 9 Phase Gate: Channels Integration Tests
 *
 * Tests end-to-end channel integration:
 * - Discord adapter lifecycle
 * - Message splitting
 * - MessageRouter known mapping routing
 * - MessageRouter unknown route (Tier 2 fallback)
 * - Message persistence
 * - Full integration wiring
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  Client,
  GatewayIntentBits,
  type Message as DiscordMessage,
} from 'discord.js';
import { DiscordAdapter } from '../channels/discord.js';
import { MessageRouterImpl } from '../channels/router.js';
import { ChannelType } from '../domain/enums.js';
import type {
  InboundMessage,
  MessageStore,
  Router,
  Orchestrator,
} from '../domain/interfaces.js';
import type { Message } from '../domain/domain.js';

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
      Guilds: 1 << 0,        // 1
      GuildMessages: 1 << 9,  // 512
      MessageContent: 1 << 15, // 32768
    },
    Partials: {
      Channel: 0,
    },
  };
});

// Helper to create an InboundMessage
function makeInboundMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: `msg-${Date.now()}`,
    chatJid: 'discord:guild-1:channel-1',
    channelType: ChannelType.Discord,
    content: 'Hello, world!',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('Layer 9: Channels Integration', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = new Client({ intents: [] });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  describe('Discord adapter lifecycle', () => {
    it('connect() creates client with correct intents and logs in', async () => {
      const adapter = new DiscordAdapter();
      process.env.DISCORD_BOT_TOKEN = 'test-token';

      await adapter.connect();

      expect(Client).toHaveBeenCalledWith({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
        ],
        partials: [0],
      });
      expect(mockClient.login).toHaveBeenCalledWith('test-token');

      delete process.env.DISCORD_BOT_TOKEN;
      await adapter.disconnect();
    });

    it('messageCreate event triggers handler with properly formatted InboundMessage', async () => {
      const adapter = new DiscordAdapter();
      process.env.DISCORD_BOT_TOKEN = 'test-token';
      await adapter.connect();

      const receivedMessages: InboundMessage[] = [];
      adapter.onMessage(async (msg) => {
        receivedMessages.push(msg);
      });

      // Get the messageCreate handler
      const onCall = mockClient.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'messageCreate'
      );
      const messageHandler = onCall![1] as (msg: DiscordMessage) => Promise<void>;

      // Simulate messageCreate event
      const mockDiscordMessage = {
        id: 'msg-123',
        guildId: 'guild-456',
        channelId: 'channel-789',
        author: { bot: false },
        content: 'Test message',
        createdTimestamp: 1234567890,
        channel: {
          isTextBased: () => true,
          sendTyping: vi.fn().mockResolvedValue(undefined),
        },
      } as unknown as DiscordMessage;

      await messageHandler(mockDiscordMessage);

      expect(receivedMessages).toHaveLength(1);
      const inboundMsg = receivedMessages[0];
      expect(inboundMsg.id).toBe('msg-123');
      expect(inboundMsg.chatJid).toBe('discord:guild-456:channel-789');
      expect(inboundMsg.channelType).toBe(ChannelType.Discord);
      expect(inboundMsg.content).toBe('Test message');
      expect(inboundMsg.timestamp).toBe(1234567890);

      delete process.env.DISCORD_BOT_TOKEN;
      await adapter.disconnect();
    });
  });

  describe('Message splitting', () => {
    it('splits 5000-char message into 3 sends', async () => {
      const adapter = new DiscordAdapter();
      process.env.DISCORD_BOT_TOKEN = 'test-token';
      await adapter.connect();

      const mockSend = vi.fn().mockResolvedValue(undefined);
      mockClient.channels.fetch.mockResolvedValue({
        isTextBased: () => true,
        send: mockSend,
      });

      const content = 'a'.repeat(5000);
      await adapter.sendMessage({
        chatJid: 'discord:guild-1:channel-1',
        content,
      });

      expect(mockSend).toHaveBeenCalledTimes(3);
      expect(mockSend).toHaveBeenNthCalledWith(1, 'a'.repeat(2000));
      expect(mockSend).toHaveBeenNthCalledWith(2, 'a'.repeat(2000));
      expect(mockSend).toHaveBeenNthCalledWith(3, 'a'.repeat(1000));

      delete process.env.DISCORD_BOT_TOKEN;
      await adapter.disconnect();
    });

    it('single send for message under 2000 chars', async () => {
      const adapter = new DiscordAdapter();
      process.env.DISCORD_BOT_TOKEN = 'test-token';
      await adapter.connect();

      const mockSend = vi.fn().mockResolvedValue(undefined);
      mockClient.channels.fetch.mockResolvedValue({
        isTextBased: () => true,
        send: mockSend,
      });

      await adapter.sendMessage({
        chatJid: 'discord:guild-1:channel-1',
        content: 'Short message',
      });

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith('Short message');

      delete process.env.DISCORD_BOT_TOKEN;
      await adapter.disconnect();
    });
  });

  describe('MessageRouter known mapping', () => {
    it('direct dispatch for mapped chatJid without calling Router.route', async () => {
      const mockMessageStore: MessageStore = {
        create: vi.fn().mockResolvedValue(undefined),
        getByChat: vi.fn().mockResolvedValue([]),
        getLatest: vi.fn().mockResolvedValue([]),
        deleteByChat: vi.fn().mockResolvedValue(undefined),
        deleteBefore: vi.fn().mockResolvedValue(0),
      };

      const mockRouter: Router = {
        route: vi.fn().mockResolvedValue('fallback-team'),
        addKnownRoute: vi.fn(),
        removeKnownRoute: vi.fn(),
        listKnownRoutes: vi.fn().mockReturnValue([]),
      };

      const mockOrchestrator: Orchestrator = {
        dispatchTask: vi.fn().mockResolvedValue(undefined),
        handleToolCall: vi.fn().mockResolvedValue({}),
        handleTaskResult: vi.fn().mockResolvedValue(undefined),
        handleEscalation: vi.fn().mockResolvedValue('corr-1'),
        handleEscalationResponse: vi.fn().mockResolvedValue(undefined),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
      };

      const router = new MessageRouterImpl(mockMessageStore, mockRouter, mockOrchestrator);

      // Set up known mapping
      router.addMapping('discord:guild-1:channel-1', 'weather-team');

      // Route a message from the mapped chatJid
      const msg = makeInboundMessage();
      await router.routeMessage(msg);

      // Router.route should NOT be called (known mapping)
      expect(mockRouter.route).not.toHaveBeenCalled();

      // Should dispatch to the mapped team
      expect(mockOrchestrator.dispatchTask).toHaveBeenCalled();
      const task = (mockOrchestrator.dispatchTask as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(task.team_slug).toBe('weather-team');
    });
  });

  describe('MessageRouter unknown route', () => {
    it('calls Router.route for unmapped chatJid (Tier 2 fallback)', async () => {
      const mockMessageStore: MessageStore = {
        create: vi.fn().mockResolvedValue(undefined),
        getByChat: vi.fn().mockResolvedValue([]),
        getLatest: vi.fn().mockResolvedValue([]),
        deleteByChat: vi.fn().mockResolvedValue(undefined),
        deleteBefore: vi.fn().mockResolvedValue(0),
      };

      const mockRouter: Router = {
        route: vi.fn().mockResolvedValue('llm-chosen-team'),
        addKnownRoute: vi.fn(),
        removeKnownRoute: vi.fn(),
        listKnownRoutes: vi.fn().mockReturnValue([]),
      };

      const mockOrchestrator: Orchestrator = {
        dispatchTask: vi.fn().mockResolvedValue(undefined),
        handleToolCall: vi.fn().mockResolvedValue({}),
        handleTaskResult: vi.fn().mockResolvedValue(undefined),
        handleEscalation: vi.fn().mockResolvedValue('corr-1'),
        handleEscalationResponse: vi.fn().mockResolvedValue(undefined),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
      };

      const router = new MessageRouterImpl(mockMessageStore, mockRouter, mockOrchestrator);

      // Route a message from an unmapped chatJid
      const msg = makeInboundMessage({ chatJid: 'discord:guild-2:channel-2' });
      await router.routeMessage(msg);

      // Router.route SHOULD be called (unknown mapping)
      expect(mockRouter.route).toHaveBeenCalledTimes(1);
      expect(mockRouter.route).toHaveBeenCalledWith(msg);

      // Should dispatch to the team returned by LLM
      expect(mockOrchestrator.dispatchTask).toHaveBeenCalled();
      const task = (mockOrchestrator.dispatchTask as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(task.team_slug).toBe('llm-chosen-team');
    });
  });

  describe('Message persistence', () => {
    it('every inbound message is stored in MessageStore', async () => {
      const mockMessageStore: MessageStore = {
        create: vi.fn().mockResolvedValue(undefined),
        getByChat: vi.fn().mockResolvedValue([]),
        getLatest: vi.fn().mockResolvedValue([]),
        deleteByChat: vi.fn().mockResolvedValue(undefined),
        deleteBefore: vi.fn().mockResolvedValue(0),
      };

      const mockRouter: Router = {
        route: vi.fn().mockRejectedValue(new Error('No route found')),
        addKnownRoute: vi.fn(),
        removeKnownRoute: vi.fn(),
        listKnownRoutes: vi.fn().mockReturnValue([]),
      };

      const router = new MessageRouterImpl(mockMessageStore, mockRouter);

      // Route a message (will fail at routing, but message should still be stored)
      const msg = makeInboundMessage();

      // The routing will throw, but message is stored first
      await expect(router.routeMessage(msg)).rejects.toThrow('No route found');

      // Message should still be stored
      expect(mockMessageStore.create).toHaveBeenCalledTimes(1);
      const storedMessage: Message = (mockMessageStore.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(storedMessage.id).toBe(msg.id);
      expect(storedMessage.chat_jid).toBe(msg.chatJid);
      expect(storedMessage.content).toBe(msg.content);
    });
  });

  describe('Integration wiring', () => {
    it('full flow: DiscordAdapter + MessageRouter + Router + mock Orchestrator', async () => {
      // Set up message store
      const storedMessages: Message[] = [];
      const mockMessageStore: MessageStore = {
        create: vi.fn().mockImplementation(async (msg: Message) => {
          storedMessages.push(msg);
        }),
        getByChat: vi.fn().mockResolvedValue([]),
        getLatest: vi.fn().mockResolvedValue([]),
        deleteByChat: vi.fn().mockResolvedValue(undefined),
        deleteBefore: vi.fn().mockResolvedValue(0),
      };

      // Set up router (Tier 2)
      const routingDecisions: InboundMessage[] = [];
      const mockRouter: Router = {
        route: vi.fn().mockImplementation(async (msg: InboundMessage) => {
          routingDecisions.push(msg);
          return 'intelligent-team';
        }),
        addKnownRoute: vi.fn(),
        removeKnownRoute: vi.fn(),
        listKnownRoutes: vi.fn().mockReturnValue([]),
      };

      // Set up orchestrator
      const dispatchedTasks: Array<{ team_slug: string; prompt: string }> = [];
      const mockOrchestrator: Orchestrator = {
        dispatchTask: vi.fn().mockImplementation(async (task) => {
          dispatchedTasks.push({
            team_slug: task.team_slug,
            prompt: task.prompt,
          });
        }),
        handleToolCall: vi.fn().mockResolvedValue({}),
        handleTaskResult: vi.fn().mockResolvedValue(undefined),
        handleEscalation: vi.fn().mockResolvedValue('corr-1'),
        handleEscalationResponse: vi.fn().mockResolvedValue(undefined),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
      };

      // Create and connect Discord adapter
      const discordAdapter = new DiscordAdapter();
      process.env.DISCORD_BOT_TOKEN = 'test-token';
      await discordAdapter.connect();

      // Create MessageRouter
      const messageRouter = new MessageRouterImpl(mockMessageStore, mockRouter, mockOrchestrator);

      // Add a known mapping
      messageRouter.addMapping('discord:guild-known:channel-known', 'mapped-team');

      // Register the Discord adapter with the router
      messageRouter.registerChannel(ChannelType.Discord, discordAdapter);

      // Get the message handler that was wired up
      const onCall = mockClient.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'messageCreate'
      );
      const messageHandler = onCall![1] as (msg: DiscordMessage) => Promise<void>;

      // Simulate an incoming message (unmapped channel)
      const mockDiscordMessage1 = {
        id: 'msg-unmapped',
        guildId: 'guild-new',
        channelId: 'channel-new',
        author: { bot: false },
        content: 'Hello from unmapped channel',
        createdTimestamp: 1000,
        channel: {
          isTextBased: () => true,
          sendTyping: vi.fn().mockResolvedValue(undefined),
        },
      } as unknown as DiscordMessage;

      await messageHandler(mockDiscordMessage1);

      // Simulate an incoming message (mapped channel)
      const mockDiscordMessage2 = {
        id: 'msg-mapped',
        guildId: 'guild-known',
        channelId: 'channel-known',
        author: { bot: false },
        content: 'Hello from mapped channel',
        createdTimestamp: 2000,
        channel: {
          isTextBased: () => true,
          sendTyping: vi.fn().mockResolvedValue(undefined),
        },
      } as unknown as DiscordMessage;

      await messageHandler(mockDiscordMessage2);

      // Verify:
      // 1. Both messages stored
      expect(storedMessages).toHaveLength(2);
      expect(storedMessages[0].id).toBe('msg-unmapped');
      expect(storedMessages[1].id).toBe('msg-mapped');

      // 2. Router.route called only for unmapped message
      expect(mockRouter.route).toHaveBeenCalledTimes(1);
      expect(routingDecisions).toHaveLength(1);
      expect(routingDecisions[0].content).toBe('Hello from unmapped channel');

      // 3. Tasks dispatched to correct teams
      expect(dispatchedTasks).toHaveLength(2);
      expect(dispatchedTasks[0].team_slug).toBe('intelligent-team'); // From Router
      expect(dispatchedTasks[0].prompt).toBe('Hello from unmapped channel');
      expect(dispatchedTasks[1].team_slug).toBe('mapped-team'); // From known mapping
      expect(dispatchedTasks[1].prompt).toBe('Hello from mapped channel');

      // Cleanup
      delete process.env.DISCORD_BOT_TOKEN;
      await discordAdapter.disconnect();
    });
  });
});