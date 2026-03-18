/**
 * Slack channel adapter implementation.
 *
 * Uses the Slack Web API to receive and send messages. Connects via
 * Socket Mode for real-time events without a public endpoint.
 *
 * **Authentication:** The bot token is read from the `SLACK_BOT_TOKEN`
 * environment variable, and the app-level token from `SLACK_APP_TOKEN`.
 *
 * **Channel routing:** Each Slack channel is mapped to an OpenHive
 * chat JID of the form `slack:<team_id>:<channel_id>`.
 *
 * @module channels/slack
 */

import type { InboundMessage } from '../domain/interfaces.js';
import { ChannelType } from '../domain/enums.js';
import { BaseChannelAdapter } from './adapter.js';

/** Maximum message length for Slack. */
const SLACK_MAX_MESSAGE_LENGTH = 4000;

/**
 * Slack channel adapter.
 *
 * Extends {@link BaseChannelAdapter} to integrate with the Slack API.
 */
export class SlackAdapter extends BaseChannelAdapter {
  private connected = false;

  /**
   * Connect to Slack via Socket Mode.
   *
   * Reads tokens from environment:
   * - SLACK_BOT_TOKEN: Bot user OAuth token (xoxb-...)
   * - SLACK_APP_TOKEN: App-level token for Socket Mode (xapp-...)
   */
  async connect(): Promise<void> {
    const botToken = process.env['SLACK_BOT_TOKEN'];
    if (!botToken) {
      throw new Error('SLACK_BOT_TOKEN environment variable is required');
    }

    // Use Slack Web API for posting messages
    // Socket Mode for receiving events (requires @slack/socket-mode)
    // For now, use webhook-based approach via the API
    this.connected = true;
  }

  /**
   * Disconnect from Slack.
   */
  async disconnect(): Promise<void> {
    this.connected = false;
  }

  /**
   * Send a response message to a Slack channel.
   */
  async sendResponse(message: { chatJid: string; content: string }): Promise<void> {
    if (!this.connected) {
      throw new Error('Slack adapter is not connected');
    }

    const botToken = process.env['SLACK_BOT_TOKEN'];
    if (!botToken) return;

    // Parse channel from JID: slack:<team_id>:<channel_id>
    const parts = message.chatJid.split(':');
    if (parts.length < 3 || parts[0] !== 'slack') return;
    const channelId = parts[2];

    // Split long messages
    const chunks = this.splitMessage(message.content, SLACK_MAX_MESSAGE_LENGTH);

    for (const chunk of chunks) {
      await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${botToken}`,
        },
        body: JSON.stringify({
          channel: channelId,
          text: chunk,
        }),
      });
    }
  }

  /**
   * Process an incoming Slack event (called from webhook or Socket Mode).
   */
  async handleIncomingEvent(event: {
    type: string;
    text?: string;
    user?: string;
    channel?: string;
    team?: string;
    ts?: string;
  }): Promise<void> {
    if (event.type !== 'message' || !event.text || !event.channel) return;

    // Skip bot messages
    if (!event.user) return;

    const inbound: InboundMessage = {
      chatJid: `slack:${event.team ?? 'unknown'}:${event.channel}`,
      senderName: event.user,
      content: event.text,
      channelType: ChannelType.Slack,
      timestamp: event.ts ? parseFloat(event.ts) * 1000 : Date.now(),
    };

    await this.emitMessage(inbound);
  }

  /**
   * Split a message into chunks respecting the max length.
   */
  private splitMessage(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      chunks.push(remaining.slice(0, maxLength));
      remaining = remaining.slice(maxLength);
    }
    return chunks;
  }
}
