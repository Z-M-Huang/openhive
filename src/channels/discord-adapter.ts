/**
 * Discord channel adapter.
 *
 * Wraps discord.js Client to implement IChannelAdapter.
 * Filters messages to watched channels (if configured), ignores bots,
 * and shows typing indicators while processing.
 *
 * Topics are internal to OpenHive — the adapter sends flat channel messages.
 *
 * Uses narrow internal interfaces for the discord.js dependency to avoid
 * coupling to the complex discord.js type hierarchy.
 */

import type { SecretString } from '../secrets/secret-string.js';
import type { ChannelMessage, IChannelAdapter } from '../domain/interfaces.js';
import type { ProgressUpdate } from '../sessions/ai-engine.js';

// ── Narrow Discord.js interfaces ──────────────────────────────────────────
// These describe only the subset of the discord.js API we actually use.
// At runtime, the real discord.js Client satisfies these interfaces.

export interface DiscordMessage {
  readonly author: { readonly bot: boolean; readonly id: string };
  readonly channelId: string;
  readonly content: string;
  readonly createdTimestamp: number;
  readonly channel: {
    sendTyping?: () => Promise<void>;
    send?: (content: string) => Promise<unknown>;
  };
}

export interface DiscordTextChannel {
  send(content: string): Promise<unknown>;
}

const DISCORD_MAX_LENGTH = 2000;

/** Send text to a Discord channel, splitting into multiple messages if needed. */
async function sendChunked(channel: DiscordTextChannel, text: string): Promise<void> {
  if (text.length <= DISCORD_MAX_LENGTH) {
    await channel.send(text);
    return;
  }
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= DISCORD_MAX_LENGTH) {
      await channel.send(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', DISCORD_MAX_LENGTH);
    if (splitAt <= 0) splitAt = DISCORD_MAX_LENGTH;
    await channel.send(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
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

/** Handler result with optional topic metadata. */
export interface DiscordHandlerResult {
  readonly response: string;
  readonly topicId?: string;
  readonly topicName?: string;
}

/** Multi-result handler shape (from channel-handler-factory). */
export interface DiscordMultiHandlerResult {
  readonly results: ReadonlyArray<{ readonly response: string; readonly topicId?: string; readonly topicName?: string }>;
}

export type DiscordProgressSender = (update: ProgressUpdate) => void;
export type DiscordMessageHandler = (
  msg: ChannelMessage,
  onProgress?: DiscordProgressSender,
) => Promise<DiscordMultiHandlerResult | DiscordHandlerResult | string | void>;

export class DiscordAdapter implements IChannelAdapter {
  readonly #token: SecretString;
  readonly #watchedChannelIds: ReadonlySet<string> | null;
  #client: DiscordClient | null;
  readonly #ownsClient: boolean;
  #lastActiveChannelId: string | null = null;
  #handler: ((msg: ChannelMessage) => Promise<void>) | null = null;
  #directHandler: DiscordMessageHandler | null = null;

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

  setHandler(handler: DiscordMessageHandler): void {
    this.#directHandler = handler;
  }

  /** Channels to notify: watched (durable) or last-active (fallback, max 1). */
  getNotifyChannelIds(): string[] {
    if (this.#watchedChannelIds) return Array.from(this.#watchedChannelIds);
    return this.#lastActiveChannelId ? [this.#lastActiveChannelId] : [];
  }

  async sendResponse(channelId: string, content: string): Promise<void> {
    if (!this.#client) return;
    const channel = await this.#client.channels.fetch(channelId);
    if (!this.#isTextChannel(channel)) return;
    await sendChunked(channel, content);
  }

  #registerMessageListener(client: DiscordClient): void {
    client.on('messageCreate', (...args: unknown[]) => {
      void this.#handleMessage(args[0] as DiscordMessage);
    });
  }

  async #handleMessage(message: DiscordMessage): Promise<void> {
    if (message.author.bot) return;
    if (this.#watchedChannelIds && !this.#watchedChannelIds.has(message.channelId)) return;
    if (!message.content.trim()) return; // Ignore empty/whitespace-only messages

    this.#lastActiveChannelId = message.channelId;

    // Show typing indicator and keep it alive every 8s while processing
    let typingInterval: ReturnType<typeof setInterval> | null = null;
    if (message.channel.sendTyping) {
      await message.channel.sendTyping().catch(() => {});
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
      if (this.#directHandler) {
        // Progress-aware path — send first assistant text as quick ack
        let ackPromise: Promise<void> | null = null;
        let ackContent = '';
        const sendProgress: DiscordProgressSender = (update) => {
          if (update.kind === 'assistant_text' && !ackPromise && this.#isTextChannel(message.channel)) {
            const trimmed = update.content.trim();
            if (trimmed) {
              ackContent = trimmed;
              ackPromise = sendChunked(message.channel, trimmed)
                .catch(() => { ackContent = ''; }); // Failed — don't dedup
            }
          }
        };
        const raw = await this.#directHandler(msg, sendProgress);
        if (ackPromise) await ackPromise; // wait for ack outcome before dedup

        // Normalize to array of results (multi-topic or single)
        type ResultEntry = { response: string; topicId?: string; topicName?: string };
        let results: ResultEntry[];
        if (raw && typeof raw === 'object' && 'results' in raw) {
          results = (raw as { results: ResultEntry[] }).results;
        } else if (raw && typeof raw === 'object' && 'response' in raw) {
          results = [raw as ResultEntry];
        } else {
          results = [{ response: (raw as string) ?? '' }];
        }

        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          if (!r.response) continue;
          let toSend = r.response;
          // Dedup ack only for first result
          if (i === 0 && ackContent && r.response.startsWith(ackContent)) {
            toSend = r.response.slice(ackContent.length).trim();
          }
          if (toSend && this.#isTextChannel(message.channel)) {
            await sendChunked(message.channel, toSend);
          }
        }
      } else if (this.#handler) {
        await this.#handler(msg);
      }
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
