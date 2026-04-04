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
 *   Client → Server:  { content: "...", topic_id: "t-abc" }
 *   Client → Server:  { type: "topic_list_request" }
 *   Server → Client:  { type: "ack",          content: "...", topic_id, topic_name }
 *   Server → Client:  { type: "progress",     content: "...", topic_id, topic_name }
 *   Server → Client:  { type: "response",     content: "...", topic_id, topic_name }
 *   Server → Client:  { type: "notification",  content: "...", topic_id?, topic_name? }
 *   Server → Client:  { type: "error",         error: "...", topic_id: null, topic_name: null }
 *   Server → Client:  { type: "topic_list",    topics: [...] }
 */

import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ChannelMessage, IChannelAdapter } from '../domain/interfaces.js';
import type { ProgressUpdate } from '../sessions/ai-engine.js';
import { errorMessage } from '../domain/errors.js';

/** Handler result with optional topic metadata. */
export interface WsHandlerResult {
  readonly response: string;
  readonly topicId?: string;
  readonly topicName?: string;
}

export type WsProgressSender = (update: ProgressUpdate) => void;

export type WsMessageHandler = (
  msg: ChannelMessage,
  onProgress?: WsProgressSender,
) => Promise<WsHandlerResult | string | void>;

interface WebSocketLike {
  readyState: number;
  send(data: string, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

type TopicListCallback = (channelId: string) => Array<{ id: string; name: string; state: string }>;

const DEFAULT_TOPIC = '__default__';

/**
 * WebSocket adapter implementing IChannelAdapter.
 *
 * - Tracks connected sockets by channelId.
 * - Per-topic request serialization (rejects concurrent messages for the same topic).
 * - Different topics process in parallel on the same socket.
 * - AI-driven ack: first assistant text → { type: "ack" }.
 */
export class WsAdapter implements IChannelAdapter {
  readonly #sockets = new Map<string, WebSocketLike>();
  /** channelId → Set of topicIds currently processing */
  readonly #processing = new Map<string, Set<string>>();
  #directHandler: WsMessageHandler | null = null;
  #topicListCallback: TopicListCallback | null = null;

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
  async sendResponse(channelId: string, content: string, topicId?: string, topicName?: string): Promise<void> {
    const ws = this.#sockets.get(channelId);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'notification', content,
        topic_id: topicId ?? null, topic_name: topicName ?? null,
      }));
    }
  }

  /** Set the direct handler for WS messages (includes onProgress). */
  setHandler(handler: WsMessageHandler): void {
    this.#directHandler = handler;
  }

  /** Set callback to retrieve topic list for a channel. */
  setTopicListCallback(cb: TopicListCallback): void {
    this.#topicListCallback = cb;
  }

  /** Send topic list to a specific channel. */
  sendTopicList(channelId: string, topics: Array<{ id: string; name: string; state: string }>): void {
    const ws = this.#sockets.get(channelId);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'topic_list', topics }));
    }
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
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(rawBuf.toString()) as Record<string, unknown>;
          } catch {
            socket.send(JSON.stringify({ type: 'error', error: 'invalid JSON', topic_id: null, topic_name: null }));
            return;
          }

          // Handle topic_list_request
          if (parsed.type === 'topic_list_request') {
            const topics = this.#topicListCallback?.(channelId) ?? [];
            this.sendTopicList(channelId, topics);
            return;
          }

          if (typeof parsed.content !== 'string' || parsed.content.trim().length === 0) {
            socket.send(JSON.stringify({ type: 'error', error: 'missing content field', topic_id: null, topic_name: null }));
            return;
          }
          const content = parsed.content.trim();
          const inboundTopicId = typeof parsed.topic_id === 'string' ? parsed.topic_id : DEFAULT_TOPIC;

          // Per-topic serialization: reject concurrent requests for the same topic
          const channelTopics = this.#processing.get(channelId);
          if (channelTopics?.has(inboundTopicId)) {
            socket.send(JSON.stringify({
              type: 'error', error: 'topic request in progress',
              topic_id: inboundTopicId === DEFAULT_TOPIC ? null : inboundTopicId,
              topic_name: null,
            }));
            return;
          }

          const msg: ChannelMessage = {
            channelId,
            userId: 'ws-client',
            content,
            timestamp: Date.now(),
            ...(inboundTopicId !== DEFAULT_TOPIC ? { topicHint: inboundTopicId } : {}),
          };

          // Track this topic as processing
          let topics = this.#processing.get(channelId);
          if (!topics) { topics = new Set(); this.#processing.set(channelId, topics); }
          topics.add(inboundTopicId);

          // Resolved topic metadata — populated from handler result
          let topicId: string | undefined;
          let topicName: string | undefined;

          // Build progress sender for this socket
          const sendProgress: WsProgressSender = (update) => {
            try {
              if (socket.readyState !== 1) return;
              const topicFields = { topic_id: topicId ?? null, topic_name: topicName ?? null };
              switch (update.kind) {
                case 'assistant_text':
                  socket.send(JSON.stringify({ type: 'ack', content: update.content, ...topicFields }));
                  break;
                case 'tool_active':
                case 'tool_summary':
                  socket.send(JSON.stringify({ type: 'progress', content: update.content, ...topicFields }));
                  break;
              }
            } catch { /* socket may have closed */ }
          };

          try {
            const result = await this.#directHandler?.(msg, sendProgress);
            // Extract topic metadata from handler result
            if (result && typeof result === 'object' && 'response' in result) {
              topicId = result.topicId;
              topicName = result.topicName;
              if (socket.readyState === 1) {
                socket.send(JSON.stringify({
                  type: 'response', content: result.response,
                  topic_id: topicId ?? null, topic_name: topicName ?? null,
                }));
              }
            } else {
              // Plain string or void from legacy handler
              if (socket.readyState === 1) {
                socket.send(JSON.stringify({
                  type: 'response', content: (typeof result === 'string' ? result : '') ?? '',
                  topic_id: topicId ?? null, topic_name: topicName ?? null,
                }));
              }
            }
          } catch (err) {
            const errMsg = errorMessage(err);
            if (socket.readyState === 1) {
              socket.send(JSON.stringify({ type: 'error', error: errMsg, topic_id: null, topic_name: null }));
            }
          } finally {
            const t = this.#processing.get(channelId);
            if (t) { t.delete(inboundTopicId); if (t.size === 0) this.#processing.delete(channelId); }
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
