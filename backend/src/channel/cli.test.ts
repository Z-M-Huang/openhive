/**
 * Tests for CLIChannel adapter.
 *
 * Approach: inject a mock readline.Interface (object with .on() and .close())
 * and a writable mock output stream. Tests capture event handlers registered
 * via .on() and invoke them directly to simulate terminal input.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CLIChannel } from './cli.js';
import type { CLIReadlineFactory } from './cli.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockRl {
  /** Invoke to simulate a line of terminal input. */
  emitLine(line: string): void;
  /** Invoke to simulate EOF / readline close event. */
  emitClose(): void;
  /** True after close() has been called. */
  closed: boolean;
}

/**
 * Creates a mock readline.Interface and its injected rlFactory.
 * Returns both so tests can emit synthetic events.
 */
function makeMockRl(): { rl: MockRl; rlFactory: CLIReadlineFactory } {
  let lineHandler: ((line: string) => void) | null = null;
  let closeHandler: (() => void) | null = null;
  let closed = false;

  const rl: MockRl = {
    get closed() {
      return closed;
    },
    emitLine(line: string) {
      lineHandler?.(line);
    },
    emitClose() {
      closeHandler?.();
    },
  };

  const mockInterface = {
    on(event: string, handler: (...args: unknown[]) => void) {
      if (event === 'line') lineHandler = handler as (line: string) => void;
      if (event === 'close') closeHandler = handler as () => void;
      return mockInterface;
    },
    close() {
      closed = true;
    },
  };

  const rlFactory = vi.fn().mockReturnValue(mockInterface) as unknown as CLIReadlineFactory;

  return { rl, rlFactory };
}

/**
 * Minimal writable stream that captures all written strings.
 */
function makeMockOutput(): { stream: NodeJS.WritableStream; get(): string; reset(): void } {
  let buf = '';
  const stream = {
    write(chunk: string) {
      buf += chunk;
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return {
    stream,
    get() {
      return buf;
    },
    reset() {
      buf = '';
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CLIChannel', () => {
  let out: ReturnType<typeof makeMockOutput>;
  let mockRl: MockRl;
  let rlFactory: CLIReadlineFactory;

  beforeEach(() => {
    out = makeMockOutput();
    ({ rl: mockRl, rlFactory } = makeMockRl());
  });

  // -------------------------------------------------------------------------
  // connect
  // -------------------------------------------------------------------------

  describe('connect', () => {
    it('creates readline interface and prints welcome banner and prompt', async () => {
      const channel = new CLIChannel(null, { output: out.stream, rlFactory });
      await channel.connect();

      expect(rlFactory).toHaveBeenCalledOnce();
      expect(out.get()).toContain('OpenHive CLI');
      expect(out.get()).toContain('<<<');
      // Prompt printed after starting read loop
      expect(out.get()).toContain('>');
      expect(channel.isConnected()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // sendMessage
  // -------------------------------------------------------------------------

  describe('sendMessage', () => {
    it('prints agent response and re-prints the input prompt', async () => {
      const channel = new CLIChannel(null, { output: out.stream, rlFactory });
      await channel.connect();
      out.reset(); // clear banner output

      await channel.sendMessage('cli:local', 'Hello from agent');

      const written = out.get();
      expect(written).toContain('Hello from agent');
      // Prompt should follow
      expect(written).toContain('>');
    });
  });

  // -------------------------------------------------------------------------
  // readLoop — single-line
  // -------------------------------------------------------------------------

  describe('readLoop', () => {
    it('dispatches single-line messages via onMessage callback', async () => {
      const channel = new CLIChannel(null, { output: out.stream, rlFactory });
      const onMsg = vi.fn();
      channel.onMessage(onMsg);
      await channel.connect();

      mockRl.emitLine('hello world');

      expect(onMsg).toHaveBeenCalledOnce();
      expect(onMsg).toHaveBeenCalledWith('cli:local', 'hello world');
    });

    it('trims whitespace from single-line input before dispatching', async () => {
      const channel = new CLIChannel(null, { output: out.stream, rlFactory });
      const onMsg = vi.fn();
      channel.onMessage(onMsg);
      await channel.connect();

      mockRl.emitLine('  spaced input  ');

      expect(onMsg).toHaveBeenCalledWith('cli:local', 'spaced input');
    });

    // -----------------------------------------------------------------------
    // readLoop — multi-line
    // -----------------------------------------------------------------------

    it('handles multi-line input (<<< … >>>)', async () => {
      const channel = new CLIChannel(null, { output: out.stream, rlFactory });
      const onMsg = vi.fn();
      channel.onMessage(onMsg);
      await channel.connect();

      mockRl.emitLine('<<<');
      mockRl.emitLine('line one');
      mockRl.emitLine('line two');
      mockRl.emitLine('>>>');

      expect(onMsg).toHaveBeenCalledOnce();
      expect(onMsg).toHaveBeenCalledWith('cli:local', 'line one\nline two');
    });

    it('does not dispatch empty multi-line block', async () => {
      const channel = new CLIChannel(null, { output: out.stream, rlFactory });
      const onMsg = vi.fn();
      channel.onMessage(onMsg);
      await channel.connect();

      mockRl.emitLine('<<<');
      mockRl.emitLine('>>>');

      expect(onMsg).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // readLoop — /quit command
    // -----------------------------------------------------------------------

    it('handles /quit: prints Goodbye! and disconnects', async () => {
      const channel = new CLIChannel(null, { output: out.stream, rlFactory });
      await channel.connect();
      out.reset();

      mockRl.emitLine('/quit');

      // Allow the disconnect microtask to run
      await Promise.resolve();

      expect(out.get()).toContain('Goodbye!');
      expect(channel.isConnected()).toBe(false);
      expect(mockRl.closed).toBe(true);
    });

    it('handles /exit: prints Goodbye! and disconnects', async () => {
      const channel = new CLIChannel(null, { output: out.stream, rlFactory });
      await channel.connect();
      out.reset();

      mockRl.emitLine('/exit');

      await Promise.resolve();

      expect(out.get()).toContain('Goodbye!');
      expect(channel.isConnected()).toBe(false);
      expect(mockRl.closed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // disconnect
  // -------------------------------------------------------------------------

  describe('disconnect', () => {
    it('closes readline interface and marks channel as disconnected', async () => {
      const channel = new CLIChannel(null, { output: out.stream, rlFactory });
      await channel.connect();

      expect(channel.isConnected()).toBe(true);
      expect(mockRl.closed).toBe(false);

      await channel.disconnect();

      expect(channel.isConnected()).toBe(false);
      expect(mockRl.closed).toBe(true);
    });

    it('is idempotent — calling disconnect twice does not throw', async () => {
      const channel = new CLIChannel(null, { output: out.stream, rlFactory });
      await channel.connect();

      await channel.disconnect();
      await expect(channel.disconnect()).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // ChannelAdapter interface
  // -------------------------------------------------------------------------

  describe('getJIDPrefix', () => {
    it('returns "cli"', () => {
      const channel = new CLIChannel();
      expect(channel.getJIDPrefix()).toBe('cli');
    });
  });
});
