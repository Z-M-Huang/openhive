/**
 * Discord channel adapter.
 *
 * Wraps discord.js Client to implement IChannelAdapter.
 * Filters messages to watched channels (if configured), ignores bots,
 * and shows typing indicators while processing.
 *
 * Topics map to native Discord threads: new topicId -> create thread,
 * messages from threads -> carry topicHint for routing.
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
    readonly id?: string;
    isThread?: () => boolean;
    sendTyping?: () => Promise<void>;
    send?: (content: string) => Promise<unknown>;
  };
}

export interface DiscordTextChannel {
  send(content: string): Promise<unknown>;
}

export interface DiscordThreadableChannel extends DiscordTextChannel {
  threads: { create(opts: { name: string; autoArchiveDuration: number }): Promise<DiscordTextChannel & { id: string }> };
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

/** Handler result with optional topic metadata for thread mapping. */
export interface DiscordHandlerResult {
  readonly response: string;
  readonly topicId?: string;
  readonly topicName?: string;
}

export type DiscordProgressSender = (update: ProgressUpdate) => void;
export type DiscordMessageHandler = (
  msg: ChannelMessage,
  onProgress?: DiscordProgressSender,
) => Promise<DiscordHandlerResult | string | void>;

export class DiscordAdapter implements IChannelAdapter {
  readonly #token: SecretString;
  readonly #watchedChannelIds: ReadonlySet<string> | null;
  #client: DiscordClient | null;
  readonly #ownsClient: boolean;
  #lastActiveChannelId: string | null = null;
  #handler: ((msg: ChannelMessage) => Promise<void>) | null = null;
  #directHandler: DiscordMessageHandler | null = null;
  readonly #topicThreadMap = new Map<string, string>(); // topicId -> threadId
  readonly #threadTopicMap = new Map<string, string>(); // threadId -> topicId

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

    // If message is from a Discord thread, carry the known topicId
    const threadTopicId = message.channel.isThread?.() && message.channel.id
      ? this.#threadTopicMap.get(message.channel.id)
      : undefined;

    const msg: ChannelMessage = {
      channelId: message.channelId,
      userId: message.author.id,
      content: message.content,
      timestamp: message.createdTimestamp,
      ...(threadTopicId && { topicHint: threadTopicId }),
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

        // Normalize: handler may return string, void, or {response, topicId?, topicName?}
        const result = typeof raw === 'object' && raw !== null && 'response' in raw
          ? raw as DiscordHandlerResult
          : { response: (raw as string) ?? '' };

        if (result.response) {
          let toSend = result.response;
          if (ackContent && result.response.startsWith(ackContent)) {
            toSend = result.response.slice(ackContent.length).trim();
          }
          if (toSend) {
            await this.#sendToThreadOrChannel(message, toSend, result.topicId, result.topicName);
          }
        }
      } else if (this.#handler) {
        await this.#handler(msg);
      }
    } finally {
      if (typingInterval) clearInterval(typingInterval);
    }
  }

  /** Route response to a thread (new or existing) when topicId is present, else main channel. */
  async #sendToThreadOrChannel(
    message: DiscordMessage, text: string, topicId?: string, topicName?: string,
  ): Promise<void> {
    if (!topicId || !this.#client) {
      if (this.#isTextChannel(message.channel)) await sendChunked(message.channel, text);
      return;
    }
    // Reuse existing thread for this topic
    const existingThreadId = this.#topicThreadMap.get(topicId);
    if (existingThreadId) {
      try {
        const thread = await this.#client.channels.fetch(existingThreadId);
        if (this.#isTextChannel(thread)) { await sendChunked(thread, text); return; }
      } catch { /* thread deleted — fall through to create */ }
    }
    // Create new thread on the parent channel
    try {
      const parent = await this.#client.channels.fetch(message.channelId);
      if (this.#isThreadableChannel(parent)) {
        const thread = await parent.threads.create({ name: topicName ?? 'Topic', autoArchiveDuration: 60 });
        this.#topicThreadMap.set(topicId, thread.id);
        this.#threadTopicMap.set(thread.id, topicId);
        await sendChunked(thread, text);
        return;
      }
    } catch {
      // Fallback: send to main channel with topic prefix
      if (this.#isTextChannel(message.channel)) {
        await sendChunked(message.channel, `[${topicName ?? 'Topic'}] ${text}`);
        return;
      }
    }
    if (this.#isTextChannel(message.channel)) await sendChunked(message.channel, text);
  }

  #isThreadableChannel(ch: unknown): ch is DiscordThreadableChannel {
    if (!this.#isTextChannel(ch)) return false;
    const rec = ch as unknown as Record<string, unknown>;
    return typeof rec['threads'] === 'object' && rec['threads'] !== null
      && typeof (rec['threads'] as Record<string, unknown>)['create'] === 'function';
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
