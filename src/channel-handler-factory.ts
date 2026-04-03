/**
 * Channel handler factory — creates the shared message handler
 * used by WS, Discord, and ChannelRouter adapters.
 *
 * Extracted from index.ts to keep it under the 300-line quality gate.
 */

import { handleMessage } from './sessions/message-handler.js';
import type { ChannelMessage, IInteractionStore } from './domain/interfaces.js';
import type { ProgressUpdate } from './sessions/ai-engine.js';

/**
 * Factory that creates a channel message handler closing over shared deps.
 * Eliminates the 3 near-identical inline handlers (ChannelRouter, WsAdapter, DiscordAdapter).
 */
export function createChannelHandler(
  handlerDeps: Parameters<typeof handleMessage>[1] | null,
  triggerEngine: { onMessage(content: string, channelId: string): void },
  interactionStore?: IInteractionStore,
): (msg: ChannelMessage, onProgress?: (update: ProgressUpdate) => void) => Promise<string> {
  return async (msg, onProgress?) => {
    triggerEngine.onMessage(msg.content, msg.channelId);

    try {
      interactionStore?.log({
        direction: 'inbound',
        channelType: msg.channelId.startsWith('ws:') ? 'ws' : msg.channelId.startsWith('discord:') ? 'discord' : 'other',
        channelId: msg.channelId,
        userId: msg.userId,
        contentSnippet: msg.content.slice(0, 2000),
        contentLength: msg.content.length,
      });
    } catch { /* logging must not crash request */ }

    if (!handlerDeps) return 'No providers configured.';
    const result = await handleMessage(msg, handlerDeps, { onProgress, sourceChannelId: msg.channelId });
    const response = result.ok ? (result.content ?? '') : `Error: ${result.error}`;

    if (response) {
      try {
        interactionStore?.log({
          direction: 'outbound',
          channelType: msg.channelId.startsWith('ws:') ? 'ws' : msg.channelId.startsWith('discord:') ? 'discord' : 'other',
          channelId: msg.channelId,
          teamId: 'main',
          contentSnippet: response.slice(0, 2000),
          contentLength: response.length,
        });
      } catch { /* logging must not crash request */ }
    }

    return response;
  };
}
