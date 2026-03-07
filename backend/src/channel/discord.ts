/**
 * OpenHive Backend - Discord Channel Adapter
 *
 * Implements ChannelAdapter for Discord using discord.js v14. Bot message
 * handling with filtering (bots, webhooks, wrong channel, self), rate limiting
 * (5 messages / 5 s), message chunking (2000-char limit with paragraph /
 * sentence / word boundary splitting), automatic reconnection with exponential
 * backoff, and config hot-reload.
 *
 * Implements automatic reconnection with exponential backoff and config hot-reload.
 */

import {
  Client,
  GatewayIntentBits,
  type Message,
  type OmitPartialGroupDMChannel,
  type TextChannel,
  type DMChannel,
  type NewsChannel,
} from 'discord.js';

import type { ChannelAdapter } from '../domain/interfaces.js';
import { ValidationError } from '../domain/errors.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DISCORD_PREFIX = 'discord';
const MAX_CHUNK_SIZE = 2000;
const RATE_WINDOW_MS = 5000;
const RATE_LIMIT = 5;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60000;
const BACKOFF_MULTIPLIER = 2;

// ---------------------------------------------------------------------------
// DiscordConfig
// ---------------------------------------------------------------------------

/**
 * Configuration for the Discord channel adapter.
 */
export interface DiscordConfig {
  token: string;
  channelID: string;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// DiscordClientInterface
// ---------------------------------------------------------------------------

/**
 * Abstraction over discord.js Client methods needed by DiscordChannel.
 * Allows injection of a mock in tests without importing discord.js Client.
 *
 * The `on` method covers event registration. The `login` method connects
 * to Discord. `destroy` disconnects. `fetchChannel` wraps client.channels.fetch.
 */
export interface DiscordClientInterface {
  login(token: string): Promise<string>;
  destroy(): Promise<void>;
  fetchChannel(channelID: string): Promise<TextChannel | DMChannel | NewsChannel | null>;
  getBotUserID(): string | null;
  on(event: 'messageCreate', listener: (message: OmitPartialGroupDMChannel<Message>) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'shardDisconnect', listener: (closeEvent: CloseEvent, shardId: number) => void): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

// ---------------------------------------------------------------------------
// RealDiscordClient  — production wrapper over discord.js Client
// ---------------------------------------------------------------------------

/**
 * Wraps a real discord.js Client to satisfy DiscordClientInterface.
 * Created internally by DiscordChannel.connect() in production.
 */
class RealDiscordClient implements DiscordClientInterface {
  private readonly client: Client;

  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
  }

  login(token: string): Promise<string> {
    return this.client.login(token);
  }

  async destroy(): Promise<void> {
    await this.client.destroy();
  }

  async fetchChannel(channelID: string): Promise<TextChannel | DMChannel | NewsChannel | null> {
    const channel = await this.client.channels.fetch(channelID);
    if (channel === null) return null;
    // Only accept text-based channels that support send()
    if (
      channel.isTextBased() &&
      (channel.type === 0 || // ChannelType.GuildText
        channel.type === 1 || // ChannelType.DM
        channel.type === 5) // ChannelType.GuildAnnouncement
    ) {
      return channel as TextChannel | DMChannel | NewsChannel;
    }
    return null;
  }

  getBotUserID(): string | null {
    return this.client.user?.id ?? null;
  }

  on(event: 'messageCreate', listener: (message: OmitPartialGroupDMChannel<Message>) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'shardDisconnect', listener: (closeEvent: CloseEvent, shardId: number) => void): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.client as any).on(event, listener);
  }
}

// ---------------------------------------------------------------------------
// DiscordClientFactory
// ---------------------------------------------------------------------------

/**
 * Factory function type for creating DiscordClientInterface instances.
 * Injectable for test isolation.
 */
export type DiscordClientFactory = () => DiscordClientInterface;

/** Default production factory. */
const defaultClientFactory: DiscordClientFactory = () => new RealDiscordClient();

// ---------------------------------------------------------------------------
// SleepFn
// ---------------------------------------------------------------------------

/**
 * Async sleep function. Injectable for test isolation (tests pass an
 * immediate-resolve mock so no real delays occur in unit tests).
 */
export type SleepFn = (ms: number) => Promise<void>;

const defaultSleepFn: SleepFn = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

/**
 * Minimal logger subset used by DiscordChannel.
 */
export interface DiscordLogger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// DiscordChannelOptions
// ---------------------------------------------------------------------------

/**
 * Optional overrides for DiscordChannel — primarily for test injection.
 */
export interface DiscordChannelOptions {
  /** Overrides the discord.js Client factory. */
  clientFactory?: DiscordClientFactory;
  /**
   * Overrides the sleep function used in reconnectLoop().
   * Pass an immediately-resolving stub in tests to skip real delays.
   */
  sleepFn?: SleepFn;
}

// ---------------------------------------------------------------------------
// DiscordChannel
// ---------------------------------------------------------------------------

/**
 * Discord channel adapter implementing ChannelAdapter.
 *
 * Key behaviour:
 *  - connect() creates a Client, registers handlers, logs in, captures bot UID.
 *  - disconnect() sets shouldReconnect=false, destroys the client.
 *  - sendMessage() chunks content and sends each chunk with rate limiting.
 *  - handleMessageCreate() filters bots / webhooks / wrong channel / self.
 *  - reconnectLoop() is triggered by 'error' and 'shardDisconnect' events and
 *    retries with exponential backoff (backoffBase * 2^attempt, cap 60 s).
 *  - handleConfigChange() compares state and connect/disconnect/reconnects.
 */
export class DiscordChannel implements ChannelAdapter {
  // Config state
  private token: string;
  private channelID: string;
  private enabled: boolean;

  // Dependencies
  private readonly clientFactory: DiscordClientFactory;
  private readonly sleepFn: SleepFn;
  private readonly logger: DiscordLogger;

  // Runtime state
  private client: DiscordClientInterface | null = null;
  private connected: boolean = false;
  private botUserID: string | null = null;

  // Callbacks registered by the MessageRouter
  private messageCallback: ((jid: string, content: string) => void) | null = null;
  private metadataCallback: ((jid: string, metadata: Record<string, string>) => void) | null = null;

  // Reconnection state
  private shouldReconnect: boolean = false;
  private reconnectAttempt: number = 0;

  // Rate limiting: timestamps of recent sends (ms)
  private sendTimes: number[] = [];

  constructor(cfg: DiscordConfig, logger: DiscordLogger, options?: DiscordChannelOptions) {
    this.token = cfg.token;
    this.channelID = cfg.channelID;
    this.enabled = cfg.enabled;
    this.logger = logger;
    this.clientFactory = options?.clientFactory ?? defaultClientFactory;
    this.sleepFn = options?.sleepFn ?? defaultSleepFn;
  }

  // ---------------------------------------------------------------------------
  // ChannelAdapter — connect
  // ---------------------------------------------------------------------------

  /**
   * Creates a discord.js Client, registers event handlers, and logs in.
   * Resolves bot user ID after login. Sets shouldReconnect=true so the
   * reconnect loop will trigger on future 'error' / 'shardDisconnect' events.
   */
  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    const client = this.clientFactory();
    this.client = client;
    this.shouldReconnect = true;

    // Register inbound message handler
    client.on(
      'messageCreate',
      (message: OmitPartialGroupDMChannel<Message>) => {
        this.handleMessageCreate(message);
      },
    );

    // Register reconnect triggers
    client.on('error', (_error: Error) => {
      if (this.shouldReconnect) {
        void this.reconnectLoop();
      }
    });

    client.on('shardDisconnect', (_closeEvent: CloseEvent, _shardId: number) => {
      if (this.shouldReconnect) {
        void this.reconnectLoop();
      }
    });

    await client.login(this.token);

    // Capture bot user ID (set by discord.js after ready)
    this.botUserID = client.getBotUserID();
    this.connected = true;
    this.reconnectAttempt = 0;

    this.logger.info('discord channel connected', { channel_id: this.channelID });
  }

  // ---------------------------------------------------------------------------
  // ChannelAdapter — disconnect
  // ---------------------------------------------------------------------------

  /**
   * Stops the reconnect loop and destroys the client.
   */
  async disconnect(): Promise<void> {
    this.shouldReconnect = false;

    if (!this.connected || this.client === null) {
      return;
    }

    try {
      await this.client.destroy();
    } catch (err) {
      this.logger.warn('discord disconnect: destroy error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.client = null;
    this.connected = false;
    this.botUserID = null;
    this.logger.info('discord channel disconnected', { channel_id: this.channelID });
  }

  // ---------------------------------------------------------------------------
  // ChannelAdapter — sendMessage
  // ---------------------------------------------------------------------------

  /**
   * Splits content into chunks of at most 2000 chars and sends each with rate
   * limiting. Throws if not connected or rate limit exceeded.
   */
  async sendMessage(_jid: string, content: string): Promise<void> {
    if (!this.connected || this.client === null) {
      throw new ValidationError('connection', 'discord channel is not connected');
    }

    const channel = await this.client.fetchChannel(this.channelID);
    if (channel === null) {
      throw new ValidationError('channel', `discord channel not found: ${this.channelID}`);
    }

    const chunks = splitMessage(content, MAX_CHUNK_SIZE);
    for (const chunk of chunks) {
      this.sendWithRateLimit(chunk);
      await channel.send(chunk);
    }
  }

  // ---------------------------------------------------------------------------
  // ChannelAdapter — getJIDPrefix / isConnected / onMessage / onMetadata
  // ---------------------------------------------------------------------------

  getJIDPrefix(): string {
    return DISCORD_PREFIX;
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
  // handleConfigChange
  // ---------------------------------------------------------------------------

  /**
   * Compares new config to current state and connect / disconnect / reconnect
   * as needed. Resets reconnectAttempt on any manual reconnect.
   */
  async handleConfigChange(
    newToken: string,
    newChannelID: string,
    newEnabled: boolean,
  ): Promise<void> {
    const oldEnabled = this.enabled;
    const oldToken = this.token;
    const oldChannelID = this.channelID;
    const wasConnected = this.connected;

    if (oldEnabled && !newEnabled) {
      // Was enabled, now disabled: disconnect.
      this.logger.info('discord: config changed — disabling channel');
      this.enabled = false;
      await this.disconnect().catch((err: unknown) => {
        this.logger.warn('discord: disconnect on disable failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } else if (!oldEnabled && newEnabled) {
      // Was disabled, now enabled: update credentials and connect.
      this.logger.info('discord: config changed — enabling channel');
      this.token = newToken;
      this.channelID = newChannelID;
      this.enabled = true;
      this.reconnectAttempt = 0;
      await this.connect().catch((err: unknown) => {
        this.logger.warn('discord: connect on enable failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } else if (newEnabled && wasConnected && (newToken !== oldToken || newChannelID !== oldChannelID)) {
      // Credentials changed while connected: reconnect.
      this.logger.info('discord: config changed — reconnecting with new credentials');
      await this.disconnect().catch((err: unknown) => {
        this.logger.warn('discord: disconnect before credential update failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      this.token = newToken;
      this.channelID = newChannelID;
      this.enabled = true;
      this.reconnectAttempt = 0;
      await this.connect().catch((err: unknown) => {
        this.logger.warn('discord: reconnect after credential update failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } else {
      // No actionable change — just update stored state.
      this.token = newToken;
      this.channelID = newChannelID;
      this.enabled = newEnabled;
    }
  }

  // ---------------------------------------------------------------------------
  // Private — handleMessageCreate
  // ---------------------------------------------------------------------------

  /**
   * Filters and dispatches an inbound discord.js message.
   * Filters: bots, webhooks, wrong channel, self, empty content.
   * Builds JID as "discord:<channelId>:<authorId>".
   */
  handleMessageCreate(message: OmitPartialGroupDMChannel<Message>): void {
    // Filter: bot messages
    if (message.author.bot) {
      return;
    }

    // Filter: webhook messages
    if (message.webhookId !== null) {
      return;
    }

    // Filter: wrong channel
    if (this.channelID !== '' && message.channelId !== this.channelID) {
      return;
    }

    // Filter: self messages
    if (this.botUserID !== null && message.author.id === this.botUserID) {
      return;
    }

    const content = message.content.trim();
    if (content === '') {
      return;
    }

    const jid = `${DISCORD_PREFIX}:${message.channelId}:${message.author.id}`;

    if (this.messageCallback !== null) {
      this.messageCallback(jid, content);
    }
  }

  // ---------------------------------------------------------------------------
  // Private — sendWithRateLimit
  // ---------------------------------------------------------------------------

  /**
   * Enforces the rate limit: at most RATE_LIMIT sends per RATE_WINDOW_MS.
   * Evicts old entries, then throws ValidationError if over limit.
   * Does NOT perform the actual send — the channel.send() call is in sendMessage().
   */
  private sendWithRateLimit(_chunk: string): void {
    const now = Date.now();
    // Evict entries outside the rate window
    this.sendTimes = this.sendTimes.filter(t => now - t < RATE_WINDOW_MS);

    if (this.sendTimes.length >= RATE_LIMIT) {
      throw new ValidationError(
        'rate_limit',
        `discord rate limit exceeded: max ${RATE_LIMIT} messages per ${RATE_WINDOW_MS}ms`,
      );
    }

    this.sendTimes.push(now);
  }

  // ---------------------------------------------------------------------------
  // reconnectLoop (exported as public for direct testing)
  // ---------------------------------------------------------------------------

  /**
   * Exponential backoff reconnection loop. Called when 'error' or
   * 'shardDisconnect' events fire. Retries connect() while shouldReconnect
   * is true. Resets reconnectAttempt on success.
   *
   * Delay = backoffBase * (backoffMultiplier ^ attempt), capped at backoffMax.
   *
   * Marked public so tests can call it directly and spy on it.
   */
  async reconnectLoop(): Promise<void> {
    // Mark disconnected so state is accurate during retry waits
    this.connected = false;
    this.client = null;

    while (this.shouldReconnect) {
      const delay = Math.min(
        BACKOFF_BASE_MS * Math.pow(BACKOFF_MULTIPLIER, this.reconnectAttempt),
        BACKOFF_MAX_MS,
      );

      this.logger.info('discord: reconnecting', {
        attempt: this.reconnectAttempt,
        delay_ms: delay,
      });

      await this.sleepFn(delay);

      if (!this.shouldReconnect) {
        break;
      }

      try {
        await this.connect();
        // Success — reset backoff
        this.reconnectAttempt = 0;
        this.logger.info('discord: reconnected successfully');
        return;
      } catch (err) {
        this.reconnectAttempt++;
        this.logger.warn('discord: reconnect attempt failed', {
          attempt: this.reconnectAttempt,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// splitMessage — exported pure function for direct testing
// ---------------------------------------------------------------------------

/**
 * Splits content into chunks of at most maxLen characters.
 * Prefers paragraph (\n\n) > sentence (. ! ?) > word > hard split.
 *
 * Prefers paragraph (\n\n) > sentence (. ! ?) > word > hard split.
 */
export function splitMessage(content: string, maxLen: number): string[] {
  if (content.length <= maxLen) {
    return [content];
  }

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > maxLen) {
    const chunk = remaining.slice(0, maxLen);

    // Prefer paragraph boundary (\n\n)
    const paraIdx = chunk.lastIndexOf('\n\n');
    if (paraIdx > 0) {
      chunks.push(remaining.slice(0, paraIdx).trimEnd());
      remaining = remaining.slice(paraIdx + 2).trimStart();
      continue;
    }

    // Prefer sentence boundary (. ! ?) followed by space or \n
    let sentIdx = -1;
    for (let i = chunk.length - 1; i >= 0; i--) {
      const ch = chunk[i];
      if (ch === '.' || ch === '!' || ch === '?') {
        const next = chunk[i + 1];
        if (next === ' ' || next === '\n' || next === undefined) {
          sentIdx = i + 1;
          break;
        }
      }
    }
    if (sentIdx > 0) {
      chunks.push(remaining.slice(0, sentIdx).trimEnd());
      remaining = remaining.slice(sentIdx).trimStart();
      continue;
    }

    // Word boundary (space or \n)
    let wordIdx = -1;
    for (let i = chunk.length - 1; i >= 0; i--) {
      if (chunk[i] === ' ' || chunk[i] === '\n') {
        wordIdx = i;
        break;
      }
    }
    if (wordIdx > 0) {
      chunks.push(remaining.slice(0, wordIdx).trimEnd());
      remaining = remaining.slice(wordIdx).trimStart();
      continue;
    }

    // Hard split at maxLen
    chunks.push(remaining.slice(0, maxLen));
    remaining = remaining.slice(maxLen);
  }

  if (remaining.trim() !== '') {
    chunks.push(remaining);
  }

  return chunks;
}

// Silence unused variable warning — metadataCallback is stored but only
// invoked by callers who register via onMetadata(). onMetadata is part of the
// interface contract even if Discord doesn't currently emit metadata events.
void (undefined as unknown as typeof DiscordChannel.prototype.onMetadata);
