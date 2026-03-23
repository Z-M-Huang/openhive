/**
 * Layer 8 Phase Gate -- Channel Adapters
 *
 * Tests:
 * - UT-19: CLI adapter sends/receives via mock streams.
 * - UT-20: Discord adapter instantiates with mocked Client.
 *          Verifies onMessage callback registered, bot messages ignored,
 *          channel filtering, typing indicators.
 * - UT-21: Router dispatches messages to callback.
 *          Router sends responses to correct adapter based on channelId.
 * - E2E-8: Full flow: message in -> router -> callback -> response out.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

import { CLIAdapter } from '../channels/cli-adapter.js';
import { DiscordAdapter, type DiscordClient } from '../channels/discord-adapter.js';
import { ChannelRouter } from '../channels/router.js';
import { SecretString } from '../secrets/secret-string.js';
import type { ChannelMessage, IChannelAdapter } from '../domain/interfaces.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Wait for the event loop to flush micro/macrotasks. */
function flush(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Create a minimal mock IChannelAdapter for router tests. */
function createMockAdapter(name: string): IChannelAdapter & {
  _handler: ((msg: ChannelMessage) => Promise<void>) | null;
  _connected: boolean;
  _sent: Array<{ channelId: string; content: string }>;
  _name: string;
} {
  const adapter = {
    _handler: null as ((msg: ChannelMessage) => Promise<void>) | null,
    _connected: false,
    _sent: [] as Array<{ channelId: string; content: string }>,
    _name: name,
    async connect() {
      adapter._connected = true;
    },
    async disconnect() {
      adapter._connected = false;
    },
    onMessage(handler: (msg: ChannelMessage) => Promise<void>) {
      adapter._handler = handler;
    },
    async sendResponse(channelId: string, content: string) {
      adapter._sent.push({ channelId, content });
    },
  };
  return adapter;
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

// ── UT-19: CLI Adapter ─────────────────────────────────────────────────────

describe('UT-19: CLI Adapter', () => {
  let input: PassThrough;
  let output: PassThrough;
  let adapter: CLIAdapter;

  beforeEach(() => {
    input = new PassThrough();
    output = new PassThrough();
    adapter = new CLIAdapter({ input, output });
  });

  it('receives lines from stdin as ChannelMessages', async () => {
    const messages: ChannelMessage[] = [];
    adapter.onMessage(async (msg) => {
      messages.push(msg);
    });
    await adapter.connect();

    input.write('hello world\n');
    await flush();

    expect(messages).toHaveLength(1);
    expect(messages[0].channelId).toBe('cli');
    expect(messages[0].userId).toBe('local');
    expect(messages[0].content).toBe('hello world');
    expect(messages[0].timestamp).toBeGreaterThan(0);

    await adapter.disconnect();
  });

  it('sends response to stdout', async () => {
    const chunks: string[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));

    await adapter.connect();
    await adapter.sendResponse('cli', 'response text');
    await flush();

    expect(chunks.join('')).toBe('response text\n');
    await adapter.disconnect();
  });

  it('ignores sendResponse for non-cli channelIds', async () => {
    const chunks: string[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));

    await adapter.connect();
    await adapter.sendResponse('discord-123', 'should be ignored');
    await flush();

    expect(chunks).toHaveLength(0);
    await adapter.disconnect();
  });

  it('handles multiple lines', async () => {
    const messages: ChannelMessage[] = [];
    adapter.onMessage(async (msg) => {
      messages.push(msg);
    });
    await adapter.connect();

    input.write('line one\nline two\nline three\n');
    await flush();

    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('line one');
    expect(messages[1].content).toBe('line two');
    expect(messages[2].content).toBe('line three');

    await adapter.disconnect();
  });

  it('disconnect closes readline', async () => {
    await adapter.connect();
    await adapter.disconnect();
    // Double disconnect is safe
    await adapter.disconnect();
  });

  it('ignores lines when no handler registered', async () => {
    await adapter.connect();
    input.write('no handler\n');
    await flush();
    // No error thrown
    await adapter.disconnect();
  });
});

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

// ── UT-21: Channel Router ──────────────────────────────────────────────────

describe('UT-21: Channel Router', () => {
  it('start connects all adapters and registers handlers', async () => {
    const a1 = createMockAdapter('adapter-1');
    const a2 = createMockAdapter('adapter-2');
    const callback = vi.fn().mockResolvedValue(undefined);

    const router = new ChannelRouter([a1, a2], callback);
    await router.start();

    expect(a1._connected).toBe(true);
    expect(a2._connected).toBe(true);
    expect(a1._handler).not.toBeNull();
    expect(a2._handler).not.toBeNull();
  });

  it('stop disconnects all adapters', async () => {
    const a1 = createMockAdapter('adapter-1');
    const callback = vi.fn().mockResolvedValue(undefined);

    const router = new ChannelRouter([a1], callback);
    await router.start();
    await router.stop();

    expect(a1._connected).toBe(false);
  });

  it('dispatches message to callback', async () => {
    const a1 = createMockAdapter('adapter-1');
    const callback = vi.fn().mockResolvedValue(undefined);

    const router = new ChannelRouter([a1], callback);
    await router.start();

    const msg: ChannelMessage = {
      channelId: 'test-chan',
      userId: 'user-1',
      content: 'hello',
      timestamp: Date.now(),
    };

    // Simulate the adapter receiving a message
    await a1._handler!(msg);

    expect(callback).toHaveBeenCalledWith(msg);
  });

  it('routes response back via the originating adapter', async () => {
    const a1 = createMockAdapter('adapter-1');
    const callback = vi.fn().mockResolvedValue('response text');

    const router = new ChannelRouter([a1], callback);
    await router.start();

    const msg: ChannelMessage = {
      channelId: 'test-chan',
      userId: 'user-1',
      content: 'hello',
      timestamp: Date.now(),
    };

    await a1._handler!(msg);

    expect(a1._sent).toHaveLength(1);
    expect(a1._sent[0]).toEqual({ channelId: 'test-chan', content: 'response text' });
  });

  it('does not send response when callback returns void', async () => {
    const a1 = createMockAdapter('adapter-1');
    const callback = vi.fn().mockResolvedValue(undefined);

    const router = new ChannelRouter([a1], callback);
    await router.start();

    const msg: ChannelMessage = {
      channelId: 'test-chan',
      userId: 'user-1',
      content: 'hello',
      timestamp: Date.now(),
    };

    await a1._handler!(msg);

    expect(a1._sent).toHaveLength(0);
  });

  it('sendResponse routes to the adapter that owns the channelId', async () => {
    const a1 = createMockAdapter('adapter-1');
    const a2 = createMockAdapter('adapter-2');
    const callback = vi.fn().mockResolvedValue(undefined);

    const router = new ChannelRouter([a1, a2], callback);
    await router.start();

    // Simulate a1 receiving a message on 'some-chan' to register ownership
    await a1._handler!({
      channelId: 'some-chan',
      userId: 'user-1',
      content: 'hello',
      timestamp: Date.now(),
    });

    await router.sendResponse('some-chan', 'targeted msg');

    // Only a1 should receive it, not a2
    expect(a1._sent).toHaveLength(1);
    expect(a1._sent[0]).toEqual({ channelId: 'some-chan', content: 'targeted msg' });
    expect(a2._sent).toHaveLength(0);
  });

  it('sendResponse is a no-op for unknown channelId', async () => {
    const a1 = createMockAdapter('adapter-1');
    const callback = vi.fn().mockResolvedValue(undefined);

    const router = new ChannelRouter([a1], callback);
    await router.start();

    await router.sendResponse('unknown-chan', 'should not arrive');

    expect(a1._sent).toHaveLength(0);
  });
});

// ── E2E-8: Full Flow ──────────────────────────────────────────────────────

describe('E2E-8: Full message flow', () => {
  it('message in -> router -> callback -> response out (CLI)', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const cliAdapter = new CLIAdapter({ input, output });

    const responses: string[] = [];
    output.on('data', (chunk: Buffer) => responses.push(chunk.toString()));

    const callback = vi.fn().mockImplementation(async (msg: ChannelMessage) => {
      return `Echo: ${msg.content}`;
    });

    const router = new ChannelRouter([cliAdapter], callback);
    await router.start();

    input.write('ping\n');
    await flush(50);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'cli',
        userId: 'local',
        content: 'ping',
      }),
    );
    expect(responses.join('')).toContain('Echo: ping');

    await router.stop();
  });

  it('multi-adapter flow: each adapter receives its own responses', async () => {
    const a1 = createMockAdapter('cli');
    const a2 = createMockAdapter('discord');

    const callback = vi.fn().mockImplementation(async (msg: ChannelMessage) => {
      return `Reply to ${msg.content}`;
    });

    const router = new ChannelRouter([a1, a2], callback);
    await router.start();

    // Simulate message from adapter 1
    await a1._handler!({
      channelId: 'cli',
      userId: 'local',
      content: 'from cli',
      timestamp: Date.now(),
    });

    // Simulate message from adapter 2
    await a2._handler!({
      channelId: 'discord-chan',
      userId: 'user-42',
      content: 'from discord',
      timestamp: Date.now(),
    });

    expect(callback).toHaveBeenCalledTimes(2);
    expect(a1._sent).toHaveLength(1);
    expect(a1._sent[0].content).toBe('Reply to from cli');
    expect(a2._sent).toHaveLength(1);
    expect(a2._sent[0].content).toBe('Reply to from discord');

    await router.stop();
  });
});
