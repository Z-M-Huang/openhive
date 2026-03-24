/**
 * Discord channel adapter.
 *
 * Wraps discord.js Client to implement IChannelAdapter.
 * Filters messages to watched channels (if configured), ignores bots,
 * and shows typing indicators while processing.
 *
 * Uses narrow internal interfaces for the discord.js dependency to avoid
 * coupling to the complex discord.js type hierarchy.
 */

import type { SecretString } from '../secrets/secret-string.js';
import type { ChannelMessage, IChannelAdapter } from '../domain/interfaces.js';

// ── Narrow Discord.js interfaces ──────────────────────────────────────────
// These describe only the subset of the discord.js API we actually use.
// At runtime, the real discord.js Client satisfies these interfaces.

export interface DiscordMessage {
  readonly author: { readonly bot: boolean; readonly id: string };
  readonly channelId: string;
  readonly content: string;
  readonly createdTimestamp: number;
  readonly channel: { sendTyping?: () => Promise<void> };
}

export interface DiscordTextChannel {
  send(content: string): Promise<unknown>;
}

export interface DiscordClient {
  login(token: string): Promise<string>;
  destroy(): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): this;
  channels: {
    fetch(id: string): Promise<unknown>;
  };
}

export interface DiscordAdapterOptions {
  readonly token: SecretString;
  readonly watchedChannelIds?: readonly string[];
  /** Injected client for testing. If omitted, a real Client is created on connect(). */
  readonly client?: DiscordClient;
}

export class DiscordAdapter implements IChannelAdapter {
  readonly #token: SecretString;
  readonly #watchedChannelIds: ReadonlySet<string> | null;
  #client: DiscordClient | null;
  readonly #ownsClient: boolean;
  #handler: ((msg: ChannelMessage) => Promise<void>) | null = null;

  constructor(options: DiscordAdapterOptions) {
    this.#token = options.token;
    this.#watchedChannelIds =
      options.watchedChannelIds && options.watchedChannelIds.length > 0
        ? new Set(options.watchedChannelIds)
        : null;

    if (options.client) {
      this.#client = options.client;
      this.#ownsClient = false;
      this.#registerMessageListener(options.client);
    } else {
      this.#client = null;
      this.#ownsClient = true;
    }
  }

  async connect(): Promise<void> {
    if (this.#ownsClient) {
      this.#client = await this.#createRealClient();
      this.#registerMessageListener(this.#client);
      await this.#client.login(this.#token.expose());
    }
  }

  async disconnect(): Promise<void> {
    if (this.#ownsClient && this.#client) {
      await this.#client.destroy();
    }
  }

  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.#handler = handler;
  }

  async sendResponse(channelId: string, content: string): Promise<void> {
    if (!this.#client) return;
    const channel = await this.#client.channels.fetch(channelId);
    if (!this.#isTextChannel(channel)) return;
    await channel.send(content);
  }

  #registerMessageListener(client: DiscordClient): void {
    client.on('messageCreate', (...args: unknown[]) => {
      void this.#handleMessage(args[0] as DiscordMessage);
    });
  }

  async #handleMessage(message: DiscordMessage): Promise<void> {
    if (message.author.bot) return;
    if (this.#watchedChannelIds && !this.#watchedChannelIds.has(message.channelId)) return;
    if (!this.#handler) return;

    // Show typing indicator and keep it alive every 8s while processing
    let typingInterval: ReturnType<typeof setInterval> | null = null;
    if (message.channel.sendTyping) {
      await message.channel.sendTyping();
      typingInterval = setInterval(() => {
        message.channel.sendTyping?.().catch(() => {});
      }, 8000);
    }

    const msg: ChannelMessage = {
      channelId: message.channelId,
      userId: message.author.id,
      content: message.content,
      timestamp: message.createdTimestamp,
    };

    try {
      await this.#handler(msg);
    } finally {
      if (typingInterval) clearInterval(typingInterval);
    }
  }

  #isTextChannel(channel: unknown): channel is DiscordTextChannel {
    return (
      typeof channel === 'object' &&
      channel !== null &&
      'send' in channel &&
      typeof (channel as Record<string, unknown>)['send'] === 'function'
    );
  }

  async #createRealClient(): Promise<DiscordClient> {
    const discordModule = await import('discord.js') as unknown as {
      Client: new (opts: { intents: number[] }) => DiscordClient;
      GatewayIntentBits: Record<string, number>;
    };
    const { Client, GatewayIntentBits } = discordModule;
    return new Client({
      intents: [
        GatewayIntentBits['Guilds'],
        GatewayIntentBits['GuildMessages'],
        GatewayIntentBits['MessageContent'],
      ],
    });
  }
}
