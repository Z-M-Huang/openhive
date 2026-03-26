/**
 * UT-21: Channel Router + E2E-8: Full channel flow
 *
 * Tests:
 * - Router dispatches messages to callback
 * - Router sends responses to correct adapter based on channelId
 * - E2E: Full flow: message in -> router -> callback -> response out
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';

import { CLIAdapter } from './cli-adapter.js';
import { ChannelRouter } from './router.js';
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
