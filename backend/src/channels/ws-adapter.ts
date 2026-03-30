/**
 * WebSocket channel adapter — implements IChannelAdapter for WS connections.
 *
 * WsAdapter owns its own message flow (with progress/ack support).
 * ChannelRouter only uses WsAdapter for sendResponse (background notifications).
 * Incoming WS messages are handled directly by the WsAdapter, NOT routed
 * through ChannelRouter's onMessage handler.
 *
 * Protocol:
 *   Client → Server:  { content: "..." }
 *   Server → Client:  { type: "ack",          content: "AI first text" }
 *   Server → Client:  { type: "progress",     content: "Working with Read (5s)" }
 *   Server → Client:  { type: "response",     content: "final result" }
 *   Server → Client:  { type: "notification",  content: "background task result" }
 *   Server → Client:  { type: "error",         error: "..." }
 */

import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ChannelMessage, IChannelAdapter } from '../domain/interfaces.js';
import type { ProgressUpdate } from '../sessions/ai-engine.js';
import { errorMessage } from '../domain/errors.js';

export type WsProgressSender = (update: ProgressUpdate) => void;

export type WsMessageHandler = (
  msg: ChannelMessage,
  onProgress?: WsProgressSender,
) => Promise<string | void>;

interface WebSocketLike {
  readyState: number;
  send(data: string, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

/**
 * WebSocket adapter implementing IChannelAdapter.
 *
 * - Tracks connected sockets by channelId.
 * - Per-socket request serialization (rejects concurrent messages).
 * - AI-driven ack: first assistant text → { type: "ack" }.
 */
export class WsAdapter implements IChannelAdapter {
  readonly #sockets = new Map<string, WebSocketLike>();
  readonly #processing = new Set<string>();
  #directHandler: WsMessageHandler | null = null;

  /**
   * IChannelAdapter: ChannelRouter calls this but WS ignores it.
   * WS routes incoming messages through #directHandler, not ChannelRouter.
   * ChannelRouter only uses WsAdapter for sendResponse (notifications).
   */
  onMessage(_handler: (msg: ChannelMessage) => Promise<void>): void {
    // No-op — see class docstring.
  }

  /**
   * IChannelAdapter: Used by external code for background notifications
   * (trigger results, task completions, etc).
   */
  async sendResponse(channelId: string, content: string): Promise<void> {
    const ws = this.#sockets.get(channelId);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'notification', content }));
    }
  }

  /** Set the direct handler for WS messages (includes onProgress). */
  setHandler(handler: WsMessageHandler): void {
    this.#directHandler = handler;
  }

  /** Return IDs of all connected channels (for broadcast). */
  getConnectedChannelIds(): string[] {
    return Array.from(this.#sockets.keys());
  }

  /** Register /ws route on Fastify. Called during bootstrap. */
  registerRoute(fastify: FastifyInstance): void {
    fastify.get('/ws', { websocket: true }, (socket: WebSocketLike) => {
      const channelId = `ws:${randomBytes(4).toString('hex')}`;
      this.#sockets.set(channelId, socket);
      socket.on('close', () => {
        this.#sockets.delete(channelId);
        this.#processing.delete(channelId);
      });

      socket.on('message', (raw: unknown) => {
        const rawBuf = raw as Buffer;
        void (async () => {
          // Per-socket serialization: reject concurrent requests
          if (this.#processing.has(channelId)) {
            socket.send(JSON.stringify({ type: 'error', error: 'request in progress' }));
            return;
          }

          let content: string;
          try {
            const parsed = JSON.parse(rawBuf.toString()) as { content?: unknown };
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

          // Build progress sender for this socket
          const sendProgress: WsProgressSender = (update) => {
            try {
              if (socket.readyState !== 1) return;
              switch (update.kind) {
                case 'assistant_text':
                  socket.send(JSON.stringify({ type: 'ack', content: update.content }));
                  break;
                case 'tool_active':
                case 'tool_summary':
                  socket.send(JSON.stringify({ type: 'progress', content: update.content }));
                  break;
              }
            } catch { /* socket may have closed */ }
          };

          this.#processing.add(channelId);
          try {
            const response = await this.#directHandler?.(msg, sendProgress);
            if (socket.readyState === 1) {
              socket.send(JSON.stringify({ type: 'response', content: response ?? '' }));
            }
          } catch (err) {
            const errMsg = errorMessage(err);
            if (socket.readyState === 1) {
              socket.send(JSON.stringify({ type: 'error', error: errMsg }));
            }
          } finally {
            this.#processing.delete(channelId);
          }
        })();
      });
    });
  }

  async connect(): Promise<void> { /* no-op — route registered externally */ }
  async disconnect(): Promise<void> {
    for (const ws of this.#sockets.values()) {
      try { ws.close(1001, 'server shutting down'); } catch { /* already closed */ }
    }
    this.#sockets.clear();
  }
}
