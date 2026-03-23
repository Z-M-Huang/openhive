/**
 * CLI channel adapter.
 *
 * Reads lines from stdin and writes responses to stdout.
 * Each line becomes a ChannelMessage with channelId='cli', userId='local'.
 */

import { createInterface, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { ChannelMessage, IChannelAdapter } from '../domain/interfaces.js';

export interface CLIAdapterOptions {
  readonly input?: Readable;
  readonly output?: Writable;
}

export class CLIAdapter implements IChannelAdapter {
  readonly #input: Readable;
  readonly #output: Writable;
  #readline: Interface | null = null;
  #handler: ((msg: ChannelMessage) => Promise<void>) | null = null;

  constructor(options?: CLIAdapterOptions) {
    this.#input = options?.input ?? process.stdin;
    this.#output = options?.output ?? process.stdout;
  }

  connect(): Promise<void> {
    this.#readline = createInterface({
      input: this.#input,
      terminal: false,
    });
    this.#readline.on('line', (line: string) => {
      if (!this.#handler) return;
      const msg: ChannelMessage = {
        channelId: 'cli',
        userId: 'local',
        content: line,
        timestamp: Date.now(),
      };
      void this.#handler(msg);
    });
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    if (this.#readline) {
      this.#readline.close();
      this.#readline = null;
    }
    return Promise.resolve();
  }

  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.#handler = handler;
  }

  sendResponse(channelId: string, content: string): Promise<void> {
    if (channelId !== 'cli') return Promise.resolve();
    this.#output.write(content + '\n');
    return Promise.resolve();
  }
}
