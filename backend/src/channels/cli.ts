/**
 * CLI channel adapter — terminal-based messaging for developer interaction.
 *
 * Provides a same-process channel adapter using Node.js readline. The developer
 * types messages in the terminal and receives responses from the main assistant.
 *
 * Chat JID format: `cli:local:0` (fixed — single-user, single session).
 *
 * Auto-enabled when `OPENHIVE_IS_ROOT=true` and stdin is a TTY.
 *
 * @module channels/cli
 */

import * as readline from 'node:readline';
import crypto from 'node:crypto';
import { BaseChannelAdapter } from './adapter.js';
import type { OutboundMessage, InboundMessage } from './adapter.js';
import { ChannelType } from '../domain/enums.js';

/** Fixed chat JID for the CLI channel (single-user system). */
export const CLI_CHAT_JID = 'cli:local:0';

/**
 * Terminal-based channel adapter for developer interaction.
 *
 * Uses Node.js readline to read user input from stdin and write
 * assistant responses to stdout. Each line of input becomes an
 * inbound message routed through the MessageRouter.
 */
export class CLIAdapter extends BaseChannelAdapter {
  private _rl: readline.Interface | null = null;
  private _connected = false;

  /**
   * Start the readline interface and begin accepting user input.
   *
   * Prints a welcome message and the `openhive> ` prompt. Each line
   * of input triggers an InboundMessage with chatJid `cli:local:0`.
   */
  async connect(): Promise<void> {
    if (this._connected) return;

    this._rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'openhive> ',
    });

    this._connected = true;

    console.log('\n--- OpenHive CLI Channel ---');
    console.log('Type a message to interact with the assistant.');
    console.log('Press Ctrl+C to exit.\n');

    this._rl.prompt();

    this._rl.on('line', (line: string) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        this._rl?.prompt();
        return;
      }

      const msg: InboundMessage = {
        id: crypto.randomUUID(),
        chatJid: CLI_CHAT_JID,
        channelType: ChannelType.Cli,
        content: trimmed,
        timestamp: Date.now(),
      };

      // Notify handlers (async, don't block readline)
      void this.notifyHandlers(msg).then(() => {
        this._rl?.prompt();
      });
    });

    this._rl.on('close', () => {
      this._connected = false;
    });
  }

  /**
   * Close the readline interface and stop accepting input.
   */
  async disconnect(): Promise<void> {
    if (this._rl) {
      this._rl.close();
      this._rl = null;
    }
    this._connected = false;
  }

  /**
   * Write an assistant response to stdout.
   *
   * Clears the current prompt line, prints the response with an
   * `[Assistant]` prefix, then re-displays the prompt.
   */
  async sendMessage(msg: OutboundMessage): Promise<void> {
    if (!this._connected) return;

    // Only handle CLI-prefixed chatJids
    if (!msg.chatJid.startsWith('cli:')) return;

    // Clear the current prompt line
    process.stdout.write('\r\x1b[K');

    // Print the response
    console.log(`[Assistant] ${msg.content}\n`);

    // Re-display the prompt
    this._rl?.prompt();
  }

  /** Whether the CLI channel is currently connected. */
  get connected(): boolean {
    return this._connected;
  }
}
