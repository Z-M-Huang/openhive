/**
 * UT-19: CLI Adapter
 *
 * Tests: CLI adapter sends/receives via mock streams
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';

import { CLIAdapter } from './cli-adapter.js';
import type { ChannelMessage } from '../domain/interfaces.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Wait for the event loop to flush micro/macrotasks. */
function flush(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
