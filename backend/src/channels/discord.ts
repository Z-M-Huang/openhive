/**
 * Discord channel adapter implementation.
 *
 * Uses discord.js to connect to the Discord Gateway, receive messages from
 * configured channels, and send responses back.
 *
 * **Authentication:** The bot token is read from the `DISCORD_BOT_TOKEN`
 * environment variable at {@link connect} time.
 *
 * **Channel routing:** Each Discord text channel is mapped to an OpenHive
 * chat JID of the form `discord:<guild_id>:<channel_id>`. The adapter
 * translates between Discord channel IDs and OpenHive JIDs so that the
 * {@link MessageRouter} can route messages to the correct team.
 *
 * **Message formatting:** Outbound messages are converted from plain text
 * to Discord-flavoured Markdown. Long messages (>2 000 chars) are
 * automatically split across multiple Discord messages. Inbound messages
 * strip Discord-specific formatting (mentions, custom emoji shortcodes)
 * into plain text before passing them to the handler pipeline.
 *
 * @example
 * ```ts
 * const discord = new DiscordAdapter();
 * discord.onMessage(async (msg) => router.routeMessage(msg));
 * await discord.connect(); // reads DISCORD_BOT_TOKEN from env
 * ```
 *
 * @see {@link BaseChannelAdapter} for the abstract base class.
 */

import { Client, Partials, type Message as DiscordMessage } from 'discord.js';

// discord.js 14.25.1 type export bug — GatewayIntentBits has broken type declaration (TS2460).
// Import the enum values directly from the discord-api-types re-export.
const GatewayIntentBits = {
  Guilds: 1 << 0,
  GuildMessages: 1 << 9,
  MessageContent: 1 << 15,
  DirectMessages: 1 << 12,
} as const;
import type { OutboundMessage, InboundMessage } from '../domain/interfaces.js';
import { ChannelType } from '../domain/enums.js';
import { BaseChannelAdapter } from './adapter.js';

/** Maximum message length for Discord. */
const DISCORD_MAX_MESSAGE_LENGTH = 2000;

/**
 * Discord channel adapter.
 *
 * Extends {@link BaseChannelAdapter} to integrate with the Discord Gateway
 * via discord.js.
 */
export class DiscordAdapter extends BaseChannelAdapter {
  private client: Client | null = null;
  private readonly configToken?: string;
  private readonly typingIntervals = new Map<string, NodeJS.Timeout>();

  constructor(botToken?: string) {
    super();
    this.configToken = botToken;
  }

  /**
   * Start persistent typing indicator for a Discord channel.
   * Sends typing every 8s (Discord expires at 10s). Auto-clears after 5min.
   */
  startProcessing(chatJid: string): void {
    if (this.typingIntervals.has(chatJid)) return;
    if (!chatJid.startsWith('discord:') || !this.client) return;
    try {
      const { channelId } = this.parseChatJid(chatJid);
      this.client.channels.fetch(channelId).then(channel => {
        if (!channel || !('sendTyping' in channel)) return;
        const textChannel = channel as { sendTyping: () => Promise<void> };
        textChannel.sendTyping().catch(() => {});
        const interval = setInterval(() => {
          textChannel.sendTyping().catch(() => {});
        }, 8000);
        this.typingIntervals.set(chatJid, interval);
        // Safety: auto-clear after 5 minutes to prevent leaks on agent failure
        setTimeout(() => this.stopProcessing(chatJid), 300_000);
      }).catch(() => {});
    } catch { /* invalid JID — skip */ }
  }

  /** Stop the typing indicator for a channel. */
  stopProcessing(chatJid: string): void {
    const interval = this.typingIntervals.get(chatJid);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(chatJid);
    }
  }

  /**
   * Connect to the Discord Gateway.
   *
   * Uses the token provided in the constructor (from openhive.yaml),
   * falling back to the DISCORD_BOT_TOKEN environment variable.
   *
   * @throws Error if no token is available or login fails.
   */
  async connect(): Promise<void> {
    const token = this.configToken || process.env['DISCORD_BOT_TOKEN'];
    if (!token) {
      throw new Error('Discord bot token not provided (set channels.discord.token in openhive.yaml or DISCORD_BOT_TOKEN env var)');
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });

    // Register message handler
    this.client.on('messageCreate', async (msg: DiscordMessage) => {
      await this.handleDiscordMessage(msg);
    });

    await this.client.login(token);
  }

  /**
   * Disconnect from the Discord Gateway.
   *
   * Calls `client.destroy()` on the discord.js `Client` instance, closing the
   * WebSocket connection and cleaning up internal listeners. Idempotent — safe
   * to call when already disconnected.
   */
  async disconnect(): Promise<void> {
    // Clear all typing intervals
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();

    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
  }

  /**
   * Send a message to a Discord text channel.
   *
   * Resolves the target channel from `msg.chatJid` (format
   * `discord:<guild_id>:<channel_id>`), and splits messages exceeding 2 000
   * characters into sequential sends.
   *
   * @param msg - The outbound message to deliver.
   * @throws Error if the client is not connected, channel is not found, or send fails.
   */
  async sendMessage(msg: OutboundMessage): Promise<void> {
    if (!this.client) {
      throw new Error('Discord client is not connected');
    }

    const { channelId } = this.parseChatJid(msg.chatJid);

    const channel = await this.client.channels.fetch(channelId);
    if (!channel) {
      throw new Error(`Discord channel not found: ${channelId}`);
    }

    if (!channel.isTextBased()) {
      throw new Error(`Discord channel is not text-based: ${channelId}`);
    }

    // Split message at 2000-char boundary
    const chunks = this.splitMessage(msg.content);
    const textChannel = channel as { send: (content: string) => Promise<unknown> };
    for (const chunk of chunks) {
      await textChannel.send(chunk);
    }
  }

  /**
   * Handle an incoming Discord message.
   *
   * - Ignores bot messages
   * - Strips Discord mentions from content
   * - Formats to InboundMessage
   * - Sends typing indicator for immediate acknowledgment (AC-L9-05)
   * - Calls notifyHandlers
   */
  private async handleDiscordMessage(msg: DiscordMessage): Promise<void> {
    // Ignore bot messages
    if (msg.author.bot) {
      return;
    }

    // Strip Discord mentions from content
    const content = this.stripMentions(msg.content);

    // Build InboundMessage
    const inboundMsg: InboundMessage = {
      id: msg.id,
      chatJid: this.buildChatJid(msg.guildId, msg.channelId),
      channelType: ChannelType.Discord,
      content,
      timestamp: msg.createdTimestamp,
    };

    // Typing indicator is now handled by startProcessing() via the router.
    // No single sendTyping() call here — the router calls startProcessing()
    // when routeMessage() fires, which starts a persistent 8s interval.

    // Notify registered handlers
    await this.notifyHandlers(inboundMsg);
  }

  /**
   * Build a chat JID from guild and channel IDs.
   *
   * Format: `discord:<guildId>:<channelId>`
   * For DMs (no guild), guildId will be 'dm'.
   */
  private buildChatJid(guildId: string | null, channelId: string): string {
    const gid = guildId ?? 'dm';
    return `discord:${gid}:${channelId}`;
  }

  /**
   * Parse a chat JID into guild and channel IDs.
   *
   * @param chatJid - Format: `discord:<guildId>:<channelId>`
   * @returns Object with guildId and channelId
   * @throws Error if the format is invalid
   */
  private parseChatJid(chatJid: string): { guildId: string; channelId: string } {
    const parts = chatJid.split(':');
    if (parts.length !== 3 || parts[0] !== 'discord') {
      throw new Error(
        `Invalid chatJid format: "${chatJid}". Expected: discord:<guildId>:<channelId>`
      );
    }
    return {
      guildId: parts[1],
      channelId: parts[2],
    };
  }

  /**
   * Strip Discord mentions from message content.
   *
   * Removes:
   * - User mentions: <@123456789> or <@!123456789>
   * - Role mentions: <@&123456789>
   * - Channel mentions: <#123456789>
   * - Everyone/here mentions: @everyone, @here
   */
  private stripMentions(content: string): string {
    return content
      .replace(/<@!?(\d+)>/g, '') // User mentions
      .replace(/<@&(\d+)>/g, '') // Role mentions
      .replace(/<#(\d+)>/g, '') // Channel mentions
      .replace(/@(everyone|here)/gi, '') // Everyone/here
      .replace(/\s+/g, ' ') // Collapse multiple spaces
      .trim();
  }

  /**
   * Split a message into chunks at Discord's 2000-character boundary.
   *
   * Splits on newline boundaries when possible for cleaner splits.
   *
   * @param content - The message content to split
   * @returns Array of message chunks, each <= 2000 characters
   */
  private splitMessage(content: string): string[] {
    if (content.length <= DISCORD_MAX_MESSAGE_LENGTH) {
      return [content];
    }

    const chunks: string[] = [];
    let remaining = content;

    while (remaining.length > 0) {
      if (remaining.length <= DISCORD_MAX_MESSAGE_LENGTH) {
        chunks.push(remaining);
        break;
      }

      // Try to split at a newline within the limit
      let splitIndex = remaining.lastIndexOf('\n', DISCORD_MAX_MESSAGE_LENGTH);

      // If no newline found, split at the character limit
      if (splitIndex === -1 || splitIndex < DISCORD_MAX_MESSAGE_LENGTH / 2) {
        splitIndex = DISCORD_MAX_MESSAGE_LENGTH;
      } else {
        // Include the newline in the current chunk
        splitIndex += 1;
      }

      chunks.push(remaining.slice(0, splitIndex));
      remaining = remaining.slice(splitIndex);
    }

    return chunks;
  }
}