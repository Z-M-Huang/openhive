/**
 * WebSocket channel adapter — registers /ws route on Fastify.
 *
 * Each WS connection gets a unique channelId.
 * Incoming: JSON { content: "..." }
 * Outgoing: JSON { type: "response", content: "..." }
 */

import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ChannelMessage } from '../domain/interfaces.js';

export type WsMessageHandler = (msg: ChannelMessage) => Promise<string | void>;

/**
 * Register the /ws WebSocket route on a Fastify instance.
 * Must be called AFTER @fastify/websocket is registered.
 */
export function registerWsRoute(
  fastify: FastifyInstance,
  onMessage: WsMessageHandler,
): void {
  fastify.get('/ws', { websocket: true }, (socket) => {
    const channelId = `ws:${randomBytes(4).toString('hex')}`;

    socket.on('message', (raw: Buffer) => {
      void (async () => {
        let content: string;
        try {
          const parsed = JSON.parse(raw.toString()) as { content?: unknown };
          if (typeof parsed.content !== 'string' || parsed.content.trim().length === 0) {
            socket.send(JSON.stringify({ type: 'error', error: 'missing content field' }));
            return;
          }
          content = parsed.content.trim();
        } catch {
          socket.send(JSON.stringify({ type: 'error', error: 'invalid JSON' }));
          return;
        }

        const msg: ChannelMessage = {
          channelId,
          userId: 'ws-client',
          content,
          timestamp: Date.now(),
        };

        try {
          const response = await onMessage(msg);
          socket.send(JSON.stringify({ type: 'response', content: response ?? '' }));
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          socket.send(JSON.stringify({ type: 'error', error: errMsg }));
        }
      })();
    });
  });
}
