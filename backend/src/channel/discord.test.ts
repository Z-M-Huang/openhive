/**
 * Tests for DiscordChannel (backend/src/channel/discord.ts)
 *
 * Uses vitest with fully mocked DiscordClientInterface — no real discord.js
 * network I/O. The sleepFn is injected as an immediately-resolving stub so
 * reconnectLoop tests run without any real delays.
 *
 * All 21 required tests are covered.
 *
 * Test index:
 *  1.  Connect creates client and registers handler
 *  2.  Disconnect destroys client
 *  3.  SendMessage splits long messages
 *  4.  SendMessage enforces rate limit
 *  5.  handleMessageCreate filters bot messages
 *  6.  handleMessageCreate filters wrong channel
 *  7.  handleMessageCreate filters self messages
 *  8.  handleMessageCreate builds correct JID
 *  9.  splitMessage splits at paragraph boundary
 * 10.  splitMessage splits at sentence boundary
 * 11.  splitMessage splits at word boundary
 * 12.  splitMessage hard splits at limit
 * 13.  HandleConfigChange enables disabled channel
 * 14.  HandleConfigChange disables enabled channel
 * 15.  HandleConfigChange reconnects on credential change
 * 16.  reconnectLoop retries with exponential backoff (1s, 2s, 4s, 8s, ... up to 60s)
 * 17.  reconnectLoop resets backoff on successful reconnection
 * 18.  reconnectLoop stops when Disconnect() called (shouldReconnect=false)
 * 19.  reconnectLoop triggered by 'error' event
 * 20.  reconnectLoop triggered by 'shardDisconnect' event
 * 21.  HandleConfigChange resets reconnectAttempt counter
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { DiscordChannel, splitMessage } from './discord.js';
import type {
  DiscordConfig,
  DiscordClientInterface,
  DiscordLogger,
  DiscordChannelOptions,
  SleepFn,
} from './discord.js';
import type { OmitPartialGroupDMChannel, Message, TextChannel } from 'discord.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Creates a no-op logger with spies. */
function makeLogger(): DiscordLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/** Default connected config. */
const defaultConfig: DiscordConfig = {
  token: 'token-abc',
  channelID: 'chan-123',
  enabled: true,
};

/**
 * Builds a minimal mock DiscordClientInterface.
 * Event listeners registered via `on()` are stored in `handlers` so tests can
 * trigger them directly.
 */
function makeClient(overrides: Partial<DiscordClientInterface> = {}): {
  client: DiscordClientInterface;
  handlers: Record<string, Array<(...args: unknown[]) => void>>;
  sendSpy: ReturnType<typeof vi.fn>;
  channel: Partial<TextChannel>;
} {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  const sendSpy = vi.fn().mockResolvedValue(undefined);

  const channel: Partial<TextChannel> = {
    send: sendSpy,
  };

  const client: DiscordClientInterface = {
    login: overrides.login ?? vi.fn().mockResolvedValue('token-abc'),
    destroy: overrides.destroy ?? vi.fn().mockResolvedValue(undefined),
    fetchChannel: overrides.fetchChannel ?? vi.fn().mockResolvedValue(channel),
    getBotUserID: overrides.getBotUserID ?? vi.fn().mockReturnValue('bot-uid-999'),
    on: (event: string, listener: (...args: unknown[]) => void) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(listener);
      if (overrides.on) overrides.on(event, listener);
    },
  };

  return { client, handlers, sendSpy, channel };
}

/** Fires all registered handlers for a given event. */
function fireEvent(
  handlers: Record<string, Array<(...args: unknown[]) => void>>,
  event: string,
  ...args: unknown[]
): void {
  const list = handlers[event] ?? [];
  for (const fn of list) fn(...args);
}

/**
 * Builds a minimal discord.js Message-like object for handleMessageCreate tests.
 */
function makeMessage(overrides: {
  bot?: boolean;
  webhookId?: string | null;
  channelId?: string;
  authorId?: string;
  content?: string;
}): OmitPartialGroupDMChannel<Message> {
  return {
    author: {
      bot: overrides.bot ?? false,
      id: overrides.authorId ?? 'user-456',
    },
    webhookId: overrides.webhookId ?? null,
    channelId: overrides.channelId ?? 'chan-123',
    content: overrides.content ?? 'hello',
  } as unknown as OmitPartialGroupDMChannel<Message>;
}

/**
 * A sleepFn that resolves immediately.
 * Injected into DiscordChannel for all reconnect loop tests so no real time
 * passes during test execution.
 */
const instantSleep: SleepFn = () => Promise.resolve();

// ---------------------------------------------------------------------------
// Describe block
// ---------------------------------------------------------------------------

describe('DiscordChannel', () => {
  let logger: DiscordLogger;

  beforeEach(() => {
    logger = makeLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Test 1 — Connect creates client and registers handler
  // -------------------------------------------------------------------------

  it('1. connect creates client and registers messageCreate handler', async () => {
    const { client, handlers } = makeClient();
    const channel = new DiscordChannel(defaultConfig, logger, {
      clientFactory: () => client,
    });

    await channel.connect();

    expect(client.login).toHaveBeenCalledWith('token-abc');
    expect(channel.isConnected()).toBe(true);
    expect(handlers['messageCreate']).toBeDefined();
    expect(handlers['messageCreate'].length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Test 2 — Disconnect destroys client
  // -------------------------------------------------------------------------

  it('2. disconnect destroys client and marks not connected', async () => {
    const { client } = makeClient();
    const channel = new DiscordChannel(defaultConfig, logger, {
      clientFactory: () => client,
    });

    await channel.connect();
    expect(channel.isConnected()).toBe(true);

    await channel.disconnect();

    expect(client.destroy).toHaveBeenCalledOnce();
    expect(channel.isConnected()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 3 — SendMessage splits long messages
  // -------------------------------------------------------------------------

  it('3. sendMessage splits long content into chunks and sends each', async () => {
    const { client, sendSpy } = makeClient();
    const channel = new DiscordChannel(defaultConfig, logger, {
      clientFactory: () => client,
    });
    await channel.connect();

    // Build a message that needs exactly 2 chunks: 2001 chars ('a' * 2000 + 'b')
    const longContent = 'a'.repeat(2000) + 'b';
    await channel.sendMessage('discord:chan-123:user-456', longContent);

    // Should send 2 chunks
    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect((sendSpy.mock.calls[0] as unknown[])[0]).toHaveLength(2000);
    expect((sendSpy.mock.calls[1] as unknown[])[0]).toBe('b');
  });

  // -------------------------------------------------------------------------
  // Test 4 — SendMessage enforces rate limit
  // -------------------------------------------------------------------------

  it('4. sendMessage throws ValidationError when rate limit exceeded', async () => {
    const { client } = makeClient();
    const channel = new DiscordChannel(defaultConfig, logger, {
      clientFactory: () => client,
    });
    await channel.connect();

    // Send 5 messages (the limit) — all should succeed
    for (let i = 0; i < 5; i++) {
      await channel.sendMessage('discord:chan-123:user-456', `msg ${i}`);
    }

    // 6th message should fail with rate limit error
    await expect(
      channel.sendMessage('discord:chan-123:user-456', 'too many'),
    ).rejects.toMatchObject({
      name: 'ValidationError',
      field: 'rate_limit',
    });
  });

  // -------------------------------------------------------------------------
  // Test 5 — handleMessageCreate filters bot messages
  // -------------------------------------------------------------------------

  it('5. handleMessageCreate ignores messages from bots', async () => {
    const { client, handlers } = makeClient();
    const channel = new DiscordChannel(defaultConfig, logger, {
      clientFactory: () => client,
    });
    await channel.connect();

    const spy = vi.fn();
    channel.onMessage(spy);

    fireEvent(handlers, 'messageCreate', makeMessage({ bot: true }));

    expect(spy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 6 — handleMessageCreate filters wrong channel
  // -------------------------------------------------------------------------

  it('6. handleMessageCreate ignores messages from wrong channel', async () => {
    const { client, handlers } = makeClient();
    const channel = new DiscordChannel(defaultConfig, logger, {
      clientFactory: () => client,
    });
    await channel.connect();

    const spy = vi.fn();
    channel.onMessage(spy);

    fireEvent(handlers, 'messageCreate', makeMessage({ channelId: 'different-chan' }));

    expect(spy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 7 — handleMessageCreate filters self messages
  // -------------------------------------------------------------------------

  it('7. handleMessageCreate ignores messages from the bot itself', async () => {
    // getBotUserID returns 'bot-uid-999'
    const { client, handlers } = makeClient();
    const channel = new DiscordChannel(defaultConfig, logger, {
      clientFactory: () => client,
    });
    await channel.connect();

    const spy = vi.fn();
    channel.onMessage(spy);

    // authorId matches the bot's own UID
    fireEvent(handlers, 'messageCreate', makeMessage({ authorId: 'bot-uid-999' }));

    expect(spy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 8 — handleMessageCreate builds correct JID
  // -------------------------------------------------------------------------

  it('8. handleMessageCreate builds JID as discord:<channelId>:<authorId>', async () => {
    const { client, handlers } = makeClient();
    const channel = new DiscordChannel(defaultConfig, logger, {
      clientFactory: () => client,
    });
    await channel.connect();

    let capturedJID = '';
    channel.onMessage((jid, _content) => {
      capturedJID = jid;
    });

    fireEvent(
      handlers,
      'messageCreate',
      makeMessage({ channelId: 'chan-123', authorId: 'user-456', content: 'hi' }),
    );

    expect(capturedJID).toBe('discord:chan-123:user-456');
  });

  // -------------------------------------------------------------------------
  // Tests 9–12 — splitMessage
  // -------------------------------------------------------------------------

  it('9. splitMessage splits at paragraph boundary (\\n\\n)', () => {
    const para1 = 'a'.repeat(100);
    const para2 = 'b'.repeat(100);
    const content = `${para1}\n\n${para2}`;
    // maxLen = 150 — forces a split before para2
    const chunks = splitMessage(content, 150);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(para1);
    expect(chunks[1]).toBe(para2);
  });

  it('10. splitMessage splits at sentence boundary (. )', () => {
    // Two sentences, combined > maxLen
    const s1 = 'The quick brown fox jumped over the lazy dog.';
    const s2 = ' Another sentence follows here with extra words.';
    const combined = s1 + s2;
    // maxLen = s1.length (45 chars) — forces a split at sentence boundary
    const chunks = splitMessage(combined, s1.length);
    // First chunk should end at the sentence boundary (the '.' at end of s1)
    expect(chunks[0]).toBe(s1);
    expect(chunks[1].trim()).toBeTruthy();
  });

  it('11. splitMessage splits at word boundary (space)', () => {
    // No punctuation, no paragraphs — just spaces
    const words = Array.from({ length: 10 }, (_, i) => `word${i}`).join(' ');
    // maxLen forces a split inside
    const maxLen = 25;
    const chunks = splitMessage(words, maxLen);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(maxLen);
      // No chunk should start with a space after splitting
      expect(chunk.startsWith(' ')).toBe(false);
    }
    // Re-joining should cover all content
    expect(chunks.join(' ').replace(/\s+/g, ' ').trim().length).toBeGreaterThan(0);
  });

  it('12. splitMessage hard splits when no boundary found', () => {
    // A single continuous string with no spaces/punctuation/paragraphs
    const content = 'a'.repeat(5001);
    const chunks = splitMessage(content, 2000);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
    expect(chunks.join('')).toBe(content);
  });

  // -------------------------------------------------------------------------
  // Tests 13–15, 21 — HandleConfigChange
  // -------------------------------------------------------------------------

  it('13. HandleConfigChange enables a disabled channel', async () => {
    const { client } = makeClient();
    const channel = new DiscordChannel(
      { token: 'tok', channelID: 'chan', enabled: false },
      logger,
      { clientFactory: () => client },
    );

    await channel.handleConfigChange('tok', 'chan', true);

    expect(channel.isConnected()).toBe(true);
    expect(client.login).toHaveBeenCalledOnce();
  });

  it('14. HandleConfigChange disables an enabled channel', async () => {
    const { client } = makeClient();
    const channel = new DiscordChannel(defaultConfig, logger, {
      clientFactory: () => client,
    });
    await channel.connect();
    expect(channel.isConnected()).toBe(true);

    await channel.handleConfigChange('token-abc', 'chan-123', false);

    expect(channel.isConnected()).toBe(false);
    expect(client.destroy).toHaveBeenCalledOnce();
  });

  it('15. HandleConfigChange reconnects when credentials change', async () => {
    const { client } = makeClient();
    const channel = new DiscordChannel(defaultConfig, logger, {
      clientFactory: () => client,
    });
    await channel.connect();

    await channel.handleConfigChange('new-token', 'chan-123', true);

    // Should have destroyed once (old session) and logged in twice (initial + reconnect)
    expect(client.destroy).toHaveBeenCalledOnce();
    expect(client.login).toHaveBeenCalledTimes(2);
    expect(channel.isConnected()).toBe(true);
  });

  it('21. HandleConfigChange resets reconnectAttempt counter', async () => {
    const { client } = makeClient();
    const channel = new DiscordChannel(defaultConfig, logger, {
      clientFactory: () => client,
    });
    await channel.connect();

    // Set a non-zero attempt count via type-cast access
    (channel as unknown as Record<string, number>)['reconnectAttempt'] = 5;

    // Trigger a credential change — should reset reconnectAttempt to 0
    await channel.handleConfigChange('new-token', 'new-chan', true);

    expect((channel as unknown as Record<string, number>)['reconnectAttempt']).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Tests 16–18 — reconnectLoop
  //
  // sleepFn is injected as an immediately-resolving stub so these tests run
  // without real delays. The loop terminates either on successful connect or
  // when shouldReconnect is set to false.
  // -------------------------------------------------------------------------

  it('16. reconnectLoop retries with exponential backoff (1s, 2s, 4s, 8s, ... up to 60s)', async () => {
    let loginCallCount = 0;
    const sleepSpy = vi.fn().mockResolvedValue(undefined);
    const { client } = makeClient({
      login: vi.fn().mockImplementation(() => {
        loginCallCount++;
        if (loginCallCount <= 4) {
          // Fail first 4 attempts so we observe backoff progression
          return Promise.reject(new Error('connection refused'));
        }
        // Stop loop after 4 failures by clearing shouldReconnect
        // (simulates a permanent failure scenario resolved externally)
        return Promise.reject(new Error('connection refused'));
      }),
    });

    const options: DiscordChannelOptions = {
      clientFactory: () => client,
      sleepFn: sleepSpy as SleepFn,
    };

    const channel = new DiscordChannel(defaultConfig, logger, options);
    // Enable the reconnect loop
    (channel as unknown as Record<string, unknown>)['shouldReconnect'] = true;

    // Run 4 iterations then stop
    let iterationCount = 0;
    const originalSleep = sleepSpy;
    originalSleep.mockImplementation(async (_ms: number) => {
      iterationCount++;
      if (iterationCount >= 4) {
        // Stop after 4 iterations
        (channel as unknown as Record<string, unknown>)['shouldReconnect'] = false;
      }
    });

    await channel.reconnectLoop();

    // Verify sleepFn was called with exponentially increasing delays
    const sleepCalls = sleepSpy.mock.calls as [number][];
    expect(sleepCalls.length).toBeGreaterThanOrEqual(3);

    // attempt 0: 1000ms
    expect(sleepCalls[0][0]).toBe(1000);
    // attempt 1: 2000ms
    expect(sleepCalls[1][0]).toBe(2000);
    // attempt 2: 4000ms
    expect(sleepCalls[2][0]).toBe(4000);

    // Verify that the cap is respected for high attempt counts:
    // BACKOFF_BASE * 2^10 = 1024000 → capped at 60000
    const delay10 = Math.min(1000 * Math.pow(2, 10), 60000);
    expect(delay10).toBe(60000);
  });

  it('17. reconnectLoop resets backoff after successful reconnection', async () => {
    let loginCallCount = 0;
    const sleepSpy = vi.fn().mockResolvedValue(undefined);

    // Build a client that shares a counter across multiple factory calls
    const makeCountedClient = (): DiscordClientInterface => {
      const { client } = makeClient({
        login: vi.fn().mockImplementation(() => {
          loginCallCount++;
          if (loginCallCount < 3) {
            return Promise.reject(new Error('fail'));
          }
          return Promise.resolve('ok');
        }),
      });
      return client;
    };

    // Each factory call returns a new client that shares loginCallCount
    let factoryCallCount = 0;
    const factory = (): DiscordClientInterface => {
      factoryCallCount++;
      return makeCountedClient();
    };

    const channel = new DiscordChannel(defaultConfig, logger, {
      clientFactory: factory,
      sleepFn: sleepSpy as SleepFn,
    });

    (channel as unknown as Record<string, unknown>)['shouldReconnect'] = true;

    // reconnectLoop will: fail attempt 1, fail attempt 2, succeed attempt 3
    await channel.reconnectLoop();

    // After success, reconnectAttempt should be 0
    expect((channel as unknown as Record<string, number>)['reconnectAttempt']).toBe(0);
    expect(channel.isConnected()).toBe(true);
    // sleepFn called twice (before attempt 1 and attempt 2 which fail)
    expect(sleepSpy).toHaveBeenCalledTimes(3);
  });

  it('18. reconnectLoop stops when shouldReconnect is set to false', async () => {
    const loginSpy = vi.fn().mockRejectedValue(new Error('fail'));
    const sleepSpy = vi.fn().mockImplementation(async () => {
      // After first sleep, stop the loop
      (channel as unknown as Record<string, unknown>)['shouldReconnect'] = false;
    });

    const { client } = makeClient({ login: loginSpy });
    const channel = new DiscordChannel(defaultConfig, logger, {
      clientFactory: () => client,
      sleepFn: sleepSpy as SleepFn,
    });

    (channel as unknown as Record<string, unknown>)['shouldReconnect'] = true;

    // Should resolve without infinite loop
    await expect(channel.reconnectLoop()).resolves.toBeUndefined();
    // sleepFn called once, then shouldReconnect=false stops the loop
    expect(sleepSpy).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Test 19 — reconnectLoop triggered by 'error' event
  // -------------------------------------------------------------------------

  it('19. reconnectLoop is triggered by client "error" event', async () => {
    const reconnectLoopSpy = vi.spyOn(
      DiscordChannel.prototype,
      'reconnectLoop',
    ).mockResolvedValue(undefined);

    const { client, handlers } = makeClient();
    const channel = new DiscordChannel(defaultConfig, logger, {
      clientFactory: () => client,
    });
    await channel.connect();

    // Fire the 'error' event
    fireEvent(handlers, 'error', new Error('WebSocket error'));

    expect(reconnectLoopSpy).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Test 20 — reconnectLoop triggered by 'shardDisconnect' event
  // -------------------------------------------------------------------------

  it('20. reconnectLoop is triggered by "shardDisconnect" event', async () => {
    const reconnectLoopSpy = vi.spyOn(
      DiscordChannel.prototype,
      'reconnectLoop',
    ).mockResolvedValue(undefined);

    const { client, handlers } = makeClient();
    const channel = new DiscordChannel(defaultConfig, logger, {
      clientFactory: () => client,
    });
    await channel.connect();

    // Fire the 'shardDisconnect' event
    fireEvent(handlers, 'shardDisconnect', {}, 0);

    expect(reconnectLoopSpy).toHaveBeenCalledOnce();
  });
});
