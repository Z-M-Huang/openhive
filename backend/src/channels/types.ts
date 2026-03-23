/**
 * Channel adapter types.
 *
 * ChannelMessage and IChannelAdapter are defined in domain/interfaces.ts.
 * This module re-exports them and adds channel-specific convenience types.
 */

export type { ChannelMessage, IChannelAdapter } from '../domain/interfaces.js';

/** Response to send back through a channel. */
export interface ChannelResponse {
  readonly channelId: string;
  readonly content: string;
}
