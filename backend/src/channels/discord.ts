/**
 * Discord channel adapter stub.
 *
 * Discord integration is planned for v2.0 (C17). This adapter will use the
 * discord.js library to connect to the Discord Gateway, receive messages from
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
 * @see C17 in Architecture-Decisions.md for the Discord-only scope decision.
 */

import type { OutboundMessage } from '../domain/interfaces.js';
import { BaseChannelAdapter } from './adapter.js';

/**
 * Discord channel adapter.
 *
 * Extends {@link BaseChannelAdapter} to integrate with the Discord Gateway
 * via discord.js. All methods currently throw — implementation is deferred
 * to v2.0 (C17).
 */
export class DiscordAdapter extends BaseChannelAdapter {
  /**
   * Connect to the Discord Gateway.
   *
   * Reads the bot token from the `DISCORD_BOT_TOKEN` environment variable,
   * instantiates a discord.js `Client` with the `GatewayIntentBits.MessageContent`
   * intent, and logs in. Registers an internal `messageCreate` listener that
   * converts each Discord `Message` into an {@link InboundMessage} and calls
   * {@link notifyHandlers}.
   *
   * @throws Error — Not implemented (Discord-only for v2.0, C17).
   */
  async connect(): Promise<void> {
    throw new Error('Not implemented');
  }

  /**
   * Disconnect from the Discord Gateway.
   *
   * Calls `client.destroy()` on the discord.js `Client` instance, closing the
   * WebSocket connection and cleaning up internal listeners. Idempotent — safe
   * to call when already disconnected.
   *
   * @throws Error — Not implemented (Discord-only for v2.0, C17).
   */
  async disconnect(): Promise<void> {
    throw new Error('Not implemented');
  }

  /**
   * Send a message to a Discord text channel.
   *
   * Resolves the target channel from `msg.chatJid` (format
   * `discord:<guild_id>:<channel_id>`), converts `msg.content` to
   * Discord-flavoured Markdown, and splits messages exceeding 2 000
   * characters into sequential sends.
   *
   * @param msg - The outbound message to deliver.
   * @throws Error — Not implemented (Discord-only for v2.0, C17).
   */
  async sendMessage(msg: OutboundMessage): Promise<void> {
    // Suppress unused-parameter lint — stub intentionally ignores msg.
    void msg;
    throw new Error('Not implemented');
  }
}
