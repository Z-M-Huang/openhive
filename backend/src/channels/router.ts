/**
 * Channel router.
 *
 * Connects multiple channel adapters and routes messages/responses
 * through a single callback. Tracks which adapter owns each channelId
 * so responses are sent only to the originating adapter.
 */

import type { ChannelMessage, IChannelAdapter } from '../domain/interfaces.js';

export type MessageHandler = (msg: ChannelMessage) => Promise<string | void>;

export class ChannelRouter {
  readonly #adapters: Map<string, IChannelAdapter> = new Map();
  readonly #onMessage: MessageHandler;
  /** Maps channelId -> adapter that last received a message on that channel. */
  readonly #channelOwners: Map<string, IChannelAdapter> = new Map();

  constructor(adapters: IChannelAdapter[], onMessage: MessageHandler) {
    for (const adapter of adapters) {
      this.#adapters.set(this.#adapterId(adapter), adapter);
    }
    this.#onMessage = onMessage;
  }

  async start(): Promise<void> {
    for (const [, adapter] of this.#adapters) {
      adapter.onMessage((msg: ChannelMessage) => this.#handleMessage(adapter, msg));
      await adapter.connect();
    }
  }

  async stop(): Promise<void> {
    for (const [, adapter] of this.#adapters) {
      await adapter.disconnect();
    }
  }

  getConnectedCount(): number {
    return this.#adapters.size;
  }

  async sendResponse(channelId: string, content: string): Promise<boolean> {
    const owner = this.#channelOwners.get(channelId);
    if (owner) {
      await owner.sendResponse(channelId, content);
      return true;
    }
    return false;
  }

  /**
   * Route a message programmatically (e.g., from the HTTP API).
   * Returns the handler response, if any.
   */
  async routeMessage(msg: ChannelMessage): Promise<string | void> {
    return this.#onMessage(msg);
  }

  async #handleMessage(adapter: IChannelAdapter, msg: ChannelMessage): Promise<void> {
    // Track which adapter owns this channel
    this.#channelOwners.set(msg.channelId, adapter);

    const response = await this.#onMessage(msg);
    if (response) {
      await adapter.sendResponse(msg.channelId, response);
    }
  }

  #adapterId(adapter: IChannelAdapter): string {
    return adapter.constructor.name + ':' + Math.random().toString(36).slice(2, 8);
  }
}
