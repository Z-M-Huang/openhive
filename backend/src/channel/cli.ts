/**
 * OpenHive Backend - CLI Channel Adapter
 *
 * Implements ChannelAdapter for stdin/stdout REPL with multi-line input support.
 * Multi-line mode: start with "<<<", end with ">>>".
 * Slash commands: /quit and /exit terminate the session.
 *
 * Key design:
 *  - connect() creates a readline.Interface from injected streams, prints welcome,
 *    and starts the read loop.
 *  - disconnect() closes the readline interface and marks the channel disconnected.
 *  - sendMessage() prints the agent response followed by the input prompt.
 *  - The readline factory is injectable for test isolation (avoids real stdin/stdout).
 *
 * The readline factory is injectable for test isolation (avoids real stdin/stdout).
 */

import * as readline from 'readline';

import type { ChannelAdapter } from '../domain/interfaces.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLI_JID = 'cli:local';
const CLI_PREFIX = 'cli';
const MULTILINE_START = '<<<';
const MULTILINE_END = '>>>';

// ---------------------------------------------------------------------------
// Injectable types
// ---------------------------------------------------------------------------

/** Factory function that creates a readline.Interface from options. */
export type CLIReadlineFactory = (options: readline.ReadLineOptions) => readline.Interface;

/** Optional constructor overrides for test isolation. */
export interface CLIChannelOptions {
  /** Input stream. Defaults to process.stdin. */
  input?: NodeJS.ReadableStream;
  /** Output stream. Defaults to process.stdout. */
  output?: NodeJS.WritableStream;
  /** readline.Interface factory. Defaults to readline.createInterface. */
  rlFactory?: CLIReadlineFactory;
}

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

/** Minimal logger subset used by CLIChannel. */
export interface CLILogger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// CLIChannel
// ---------------------------------------------------------------------------

/**
 * CLI channel adapter implementing ChannelAdapter.
 *
 * Implements ChannelAdapter for stdin/stdout REPL.
 */
export class CLIChannel implements ChannelAdapter {
  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  private connected: boolean = false;
  private rl: readline.Interface | null = null;

  // ---------------------------------------------------------------------------
  // Callbacks registered by MessageRouter
  // ---------------------------------------------------------------------------

  private messageCallback: ((jid: string, content: string) => void) | null = null;
  private metadataCallback:
    | ((jid: string, metadata: Record<string, string>) => void)
    | null = null;

  // ---------------------------------------------------------------------------
  // Injectable dependencies
  // ---------------------------------------------------------------------------

  private readonly logger: CLILogger | null;
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readonly rlFactory: CLIReadlineFactory;

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  constructor(logger: CLILogger | null = null, options?: CLIChannelOptions) {
    this.logger = logger;
    this.input = options?.input ?? process.stdin;
    this.output = options?.output ?? process.stdout;
    this.rlFactory = options?.rlFactory ?? readline.createInterface;
  }

  // ---------------------------------------------------------------------------
  // ChannelAdapter — connect
  // ---------------------------------------------------------------------------

  /**
   * Creates the readline interface, prints the welcome banner, and starts the
   * read loop. Non-blocking: read loop runs via readline events.
   */
  async connect(): Promise<void> {
    this.connected = true;

    this.rl = this.rlFactory({
      input: this.input,
      output: this.output,
      terminal: false,
    });

    this.output.write('OpenHive CLI - Type a message or /quit to exit\n');
    this.output.write('Use <<< to start multi-line input, >>> to end\n');

    this.startReadLoop();

    this.logger?.info('cli channel connected');
  }

  // ---------------------------------------------------------------------------
  // ChannelAdapter — disconnect
  // ---------------------------------------------------------------------------

  /**
   * Closes the readline interface and marks the channel as disconnected.
   */
  async disconnect(): Promise<void> {
    if (!this.connected) {
      return;
    }
    this.connected = false;
    this.rl?.close();
    this.rl = null;

    this.logger?.info('cli channel disconnected');
  }

  // ---------------------------------------------------------------------------
  // ChannelAdapter — sendMessage
  // ---------------------------------------------------------------------------

  /**
   * Prints the agent response to stdout followed by the input prompt.
   */
  async sendMessage(_jid: string, content: string): Promise<void> {
    this.output.write(`\n${content}\n`);
    this.printPrompt();
  }

  // ---------------------------------------------------------------------------
  // ChannelAdapter — getJIDPrefix / isConnected / onMessage / onMetadata
  // ---------------------------------------------------------------------------

  getJIDPrefix(): string {
    return CLI_PREFIX;
  }

  isConnected(): boolean {
    return this.connected;
  }

  onMessage(callback: (jid: string, content: string) => void): void {
    this.messageCallback = callback;
  }

  onMetadata(callback: (jid: string, metadata: Record<string, string>) => void): void {
    this.metadataCallback = callback;
    void this.metadataCallback; // stored for future use; satisfies noUnusedLocals
  }

  // ---------------------------------------------------------------------------
  // Private — read loop
  // ---------------------------------------------------------------------------

  /**
   * Attaches 'line' and 'close' event handlers to the readline interface.
   * Uses a local `multilineBuffer` to collect lines between <<< and >>>.
   *
   * Handles single-line input, multi-line mode (<<< ... >>>), and slash commands.
   */
  private startReadLoop(): void {
    if (this.rl === null) {
      return;
    }

    let multilineBuffer: string[] | null = null;

    this.printPrompt();

    this.rl.on('line', (line: string) => {
      if (!this.connected) {
        return;
      }

      // Multi-line mode: accumulate lines until >>>
      if (multilineBuffer !== null) {
        if (line.trim() === MULTILINE_END) {
          const content = multilineBuffer.join('\n');
          multilineBuffer = null;
          if (content !== '') {
            this.dispatchMessage(content);
          }
        } else {
          multilineBuffer.push(line);
        }
        return;
      }

      // Start multi-line mode
      if (line.trim() === MULTILINE_START) {
        multilineBuffer = [];
        return;
      }

      const trimmed = line.trim();

      // Slash commands — /quit and /exit terminate the session
      if (trimmed === '/quit' || trimmed === '/exit') {
        this.output.write('Goodbye!\n');
        void this.disconnect();
        return;
      }

      // Empty line — re-print prompt
      if (trimmed === '') {
        this.printPrompt();
        return;
      }

      this.dispatchMessage(trimmed);
    });

    this.rl.on('close', () => {
      // EOF (Ctrl+D) or disconnect() — mark disconnected
      this.connected = false;
    });
  }

  // ---------------------------------------------------------------------------
  // Private — helpers
  // ---------------------------------------------------------------------------

  /**
   * Prints the waiting indicator and dispatches via the onMessage callback.
   */
  private dispatchMessage(content: string): void {
    this.output.write('...');

    if (this.messageCallback !== null) {
      this.messageCallback(CLI_JID, content);
    }
  }

  /** Prints the "> " prompt to output. */
  private printPrompt(): void {
    this.output.write('> ');
  }
}

// Silence unused variable warning — metadataCallback is stored but only
// invoked by callers who register via onMetadata(). This matches the pattern
// used in api.ts and discord.ts where onMetadata is part of the interface
// contract even if the CLI channel does not currently emit metadata events.
void (undefined as unknown as typeof CLIChannel.prototype.onMetadata);
