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

import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message as DiscordMessage,
} from 'discord.js';
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

  /**
   * Connect to the Discord Gateway.
   *
   * Reads the bot token from the `DISCORD_BOT_TOKEN` environment variable,
   * instantiates a discord.js `Client` with the required intents, and logs in.
   * Registers an internal `messageCreate` listener that converts each Discord
   * `Message` into an {@link InboundMessage} and calls {@link notifyHandlers}.
   *
   * @throws Error if DISCORD_BOT_TOKEN is not set or login fails.
   */
  async connect(): Promise<void> {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
      throw new Error('DISCORD_BOT_TOKEN environment variable is not set');
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

    // Immediate acknowledgment: send typing indicator (AC-L9-05)
    if (msg.channel.isTextBased() && 'sendTyping' in msg.channel) {
      await (msg.channel as { sendTyping: () => Promise<void> }).sendTyping();
    }

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