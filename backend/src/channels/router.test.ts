/**
 * Tests for MessageRouterImpl.
 *
 * Tests the two-tier message routing system with mocked stores and router.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageRouterImpl } from './router.js';
import { ChannelType } from '../domain/enums.js';
import type {
  InboundMessage,
  MessageStore,
  Router,
  ChannelAdapter,
  Orchestrator,
} from '../domain/interfaces.js';

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

describe('MessageRouterImpl', () => {
  let router: MessageRouterImpl;
  let mockMessageStore: MessageStore;
  let mockRouter: Router;
  let mockOrchestrator: Orchestrator;

  beforeEach(() => {
    // Create mock message store
    mockMessageStore = {
      create: vi.fn().mockResolvedValue(undefined),
      getByChat: vi.fn().mockResolvedValue([]),
      getLatest: vi.fn().mockResolvedValue([]),
      deleteByChat: vi.fn().mockResolvedValue(undefined),
      deleteBefore: vi.fn().mockResolvedValue(0),
    };

    // Create mock router (Tier 2)
    mockRouter = {
      route: vi.fn().mockResolvedValue('default-team'),
      addKnownRoute: vi.fn(),
      removeKnownRoute: vi.fn(),
      listKnownRoutes: vi.fn().mockReturnValue([]),
    };

    // Create mock orchestrator
    mockOrchestrator = {
      dispatchTask: vi.fn().mockResolvedValue(undefined),
      handleToolCall: vi.fn().mockResolvedValue({}),
      handleTaskResult: vi.fn().mockResolvedValue(undefined),
      handleEscalation: vi.fn().mockResolvedValue('corr-1'),
      handleEscalationResponse: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };

    router = new MessageRouterImpl(mockMessageStore, mockRouter, mockOrchestrator);
  });

  describe('registerChannel()', () => {
    it('wires adapter handler to routeMessage', async () => {
      const mockAdapter: ChannelAdapter = {
        onMessage: vi.fn(),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      router.registerChannel(ChannelType.Discord, mockAdapter);

      expect(mockAdapter.onMessage).toHaveBeenCalled();
      const handler = (mockAdapter.onMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];

      // Test that the handler calls routeMessage
      const msg = makeInboundMessage();
      await handler(msg);

      expect(mockMessageStore.create).toHaveBeenCalled();
    });

    it('replaces existing adapter for same channel type', async () => {
      const mockAdapter1: ChannelAdapter = {
        onMessage: vi.fn(),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      const mockAdapter2: ChannelAdapter = {
        onMessage: vi.fn(),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      router.registerChannel(ChannelType.Discord, mockAdapter1);
      router.registerChannel(ChannelType.Discord, mockAdapter2);

      expect(router.listChannels()).toHaveLength(1);
    });
  });

  describe('unregisterChannel()', () => {
    it('removes adapter from registry', async () => {
      const mockAdapter: ChannelAdapter = {
        onMessage: vi.fn(),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      router.registerChannel(ChannelType.Discord, mockAdapter);
      expect(router.listChannels()).toHaveLength(1);

      router.unregisterChannel(ChannelType.Discord);
      expect(router.listChannels()).toHaveLength(0);
    });
  });

  describe('addMapping() / removeMapping()', () => {
    it('adds and retrieves a mapping', () => {
      router.addMapping('discord:guild-1:channel-1', 'weather-team');
      expect(router.getMapping('discord:guild-1:channel-1')).toBe('weather-team');
    });

    it('removes a mapping', () => {
      router.addMapping('discord:guild-1:channel-1', 'weather-team');
      router.removeMapping('discord:guild-1:channel-1');
      expect(router.getMapping('discord:guild-1:channel-1')).toBeUndefined();
    });
  });

  describe('routeMessage()', () => {
    it('persists message to MessageStore', async () => {
      const msg = makeInboundMessage();
      await router.routeMessage(msg);

      expect(mockMessageStore.create).toHaveBeenCalledTimes(1);
      const storedMessage = (mockMessageStore.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(storedMessage.id).toBe(msg.id);
      expect(storedMessage.chat_jid).toBe(msg.chatJid);
      expect(storedMessage.content).toBe(msg.content);
      expect(storedMessage.role).toBe('user');
    });

    it('known mapping: direct dispatch without calling Router.route', async () => {
      router.addMapping('discord:guild-1:channel-1', 'weather-team');

      const msg = makeInboundMessage();
      await router.routeMessage(msg);

      // Should NOT call the Router for known mappings
      expect(mockRouter.route).not.toHaveBeenCalled();

      // Should dispatch to the known team
      expect(mockOrchestrator.dispatchTask).toHaveBeenCalled();
      const task = (mockOrchestrator.dispatchTask as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(task.team_slug).toBe('weather-team');
    });

    it('no known mapping: calls Router.route (Tier 2 fallback)', async () => {
      const msg = makeInboundMessage({
        chatJid: 'discord:guild-2:channel-2',
      });
      await router.routeMessage(msg);

      // Should call Router for unknown chatJid
      expect(mockRouter.route).toHaveBeenCalledTimes(1);
      expect(mockRouter.route).toHaveBeenCalledWith(msg);

      // Should dispatch to the team returned by Router
      expect(mockOrchestrator.dispatchTask).toHaveBeenCalled();
      const task = (mockOrchestrator.dispatchTask as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(task.team_slug).toBe('default-team');
    });

    it('message is stored even if routing fails', async () => {
      (mockRouter.route as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('No route found')
      );

      const msg = makeInboundMessage();

      // Should throw from Router, but message should still be stored
      await expect(router.routeMessage(msg)).rejects.toThrow('No route found');
      expect(mockMessageStore.create).toHaveBeenCalled();
    });

    it('works without orchestrator (for testing)', async () => {
      const routerNoOrch = new MessageRouterImpl(mockMessageStore, mockRouter);

      routerNoOrch.addMapping('discord:guild-1:channel-1', 'weather-team');

      const msg = makeInboundMessage();
      // Should not throw
      await routerNoOrch.routeMessage(msg);

      expect(mockMessageStore.create).toHaveBeenCalled();
    });
  });

  describe('integration wiring', () => {
    it('full flow: registerChannel -> receive message -> route', async () => {
      // Create a mock adapter that simulates receiving a message
      let registeredHandler: ((msg: InboundMessage) => Promise<void>) | null = null;
      const mockAdapter: ChannelAdapter = {
        onMessage: vi.fn((handler) => {
          registeredHandler = handler;
        }),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      // Set up known mapping
      router.addMapping('discord:guild-1:channel-1', 'weather-team');

      // Register the adapter
      router.registerChannel(ChannelType.Discord, mockAdapter);

      // Simulate receiving a message
      const msg = makeInboundMessage();
      await registeredHandler!(msg);

      // Verify the flow
      expect(mockMessageStore.create).toHaveBeenCalled();
      expect(mockOrchestrator.dispatchTask).toHaveBeenCalled();
    });
  });
});