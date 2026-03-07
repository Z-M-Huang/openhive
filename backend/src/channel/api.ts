/**
 * OpenHive Backend - API Channel Adapter
 *
 * Implements ChannelAdapter for REST-based synchronous request/response.
 * Each POST /api/chat request blocks until the agent responds or the
 * request times out (5 minutes).
 *
 * Key design:
 *  - pending: Map<jid, {resolve, reject}> for in-flight HTTP requests.
 *  - handleChat() is a Fastify route handler. It registers a pending entry,
 *    dispatches via the onMessage callback, then awaits the response.
 *  - sendMessage() resolves the pending promise for a given JID.
 *  - disconnect() rejects all pending promises.
 *  - The timeout duration is injectable for test isolation.
 *
 * The timeout duration is injectable for test isolation.
 */

import type { ChannelAdapter } from '../domain/interfaces.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_PREFIX = 'api';

/** Default request timeout: 5 minutes in milliseconds. */
const API_TIMEOUT_MS = 300_000;

/** Maximum JSON body size accepted by handleChat: 1 MB. */
export const API_MAX_BODY_SIZE = 1_048_576;

// ---------------------------------------------------------------------------
// Fastify shim types
// ---------------------------------------------------------------------------

/**
 * Minimal Fastify request shape needed by handleChat.
 * Using a structural interface keeps this file free of the fastify import
 * at the type level, matching the same pattern used across the backend
 * (domain layer never imports fastify directly).
 */
export interface APIFastifyRequest {
  body: unknown;
  headers: { 'content-length'?: string; [key: string]: string | string[] | undefined };
}

/**
 * Minimal Fastify reply shape needed by handleChat.
 */
export interface APIFastifyReply {
  code(statusCode: number): APIFastifyReply;
  send(payload: unknown): void;
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/** Expected JSON body shape for POST /api/chat. */
interface ChatRequestBody {
  content: string;
}

/** Type guard: validates that the parsed body has the expected shape. */
function isChatRequestBody(value: unknown): value is ChatRequestBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'content' in value &&
    typeof (value as Record<string, unknown>)['content'] === 'string'
  );
}

/** Success response shape. */
interface ChatResponseData {
  response: string;
}

/** Error response shape, matching the api package format. */
interface ChatErrorResponse {
  error: { code: string; message: string };
}

/** Success response wrapper. */
interface ChatSuccessResponse {
  data: ChatResponseData;
}

// ---------------------------------------------------------------------------
// Pending entry — a single in-flight HTTP request waiting for agent response
// ---------------------------------------------------------------------------

interface PendingEntry {
  resolve: (content: string) => void;
  reject: (err: Error) => void;
}

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

/**
 * Minimal logger subset used by APIChannel.
 */
export interface APILogger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// APIChannelOptions — injectable dependencies for test isolation
// ---------------------------------------------------------------------------

/**
 * Optional constructor overrides. Pass a short timeoutMs in tests to avoid
 * 5-minute real waits.
 */
export interface APIChannelOptions {
  /**
   * Override the request timeout in milliseconds.
   * Defaults to API_TIMEOUT_MS (300 000 ms = 5 minutes) when not set.
   */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// APIChannel
// ---------------------------------------------------------------------------

/**
 * REST-based channel adapter implementing ChannelAdapter.
 *
 * Key behaviour:
 *  - connect() marks the channel as ready to accept requests.
 *  - disconnect() marks the channel as unavailable and rejects all pending promises.
 *  - sendMessage() resolves the pending promise for the given JID (non-blocking;
 *    silently ignores unknown JIDs where the request already timed out).
 *  - handleChat() is a Fastify route handler for POST /api/chat.
 *    It validates the request, generates a unique JID, registers a pending entry,
 *    dispatches via the onMessage callback, then awaits the response.
 *
 * Implements ChannelAdapter for the REST API.
 */
export class APIChannel implements ChannelAdapter {
  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  private connected: boolean = false;

  /**
   * Map of in-flight JIDs to their resolve/reject callbacks.
   * Node.js is single-threaded so no locking is needed.
   */
  private readonly pending: Map<string, PendingEntry> = new Map();

  /** Monotonically increasing counter for JID generation. */
  private counter: number = 0;

  // ---------------------------------------------------------------------------
  // Callbacks registered by MessageRouter
  // ---------------------------------------------------------------------------

  private messageCallback: ((jid: string, content: string) => void) | null = null;
  private metadataCallback:
    | ((jid: string, metadata: Record<string, string>) => void)
    | null = null;

  // ---------------------------------------------------------------------------
  // Injectable dependencies
  // ---------------------------------------------------------------------------

  private readonly logger: APILogger | null;
  private readonly timeoutMs: number;

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  constructor(logger: APILogger | null = null, options?: APIChannelOptions) {
    this.logger = logger;
    this.timeoutMs =
      options?.timeoutMs !== undefined && options.timeoutMs > 0
        ? options.timeoutMs
        : API_TIMEOUT_MS;
  }

  // ---------------------------------------------------------------------------
  // ChannelAdapter — connect
  // ---------------------------------------------------------------------------

  /**
   * Marks the channel as connected and ready to accept requests.
   */
  async connect(): Promise<void> {
    this.connected = true;
    this.logger?.info('api channel connected');
  }

  // ---------------------------------------------------------------------------
  // ChannelAdapter — disconnect
  // ---------------------------------------------------------------------------

  /**
   * Marks the channel as disconnected and rejects all pending promises.
   * Any in-flight handleChat calls will receive a 503 response.
   */
  async disconnect(): Promise<void> {
    this.connected = false;

    const err = new Error('channel disconnected');
    for (const [jid, entry] of this.pending.entries()) {
      this.logger?.debug('api channel: rejecting pending request on disconnect', { jid });
      entry.reject(err);
    }
    this.pending.clear();

    this.logger?.info('api channel disconnected');
  }

  // ---------------------------------------------------------------------------
  // ChannelAdapter — sendMessage
  // ---------------------------------------------------------------------------

  /**
   * Delivers the agent's response to the pending HTTP request identified by JID.
   * Non-blocking: silently ignores unknown JIDs (request may have timed out
   * or client disconnected).
   *
   * Non-blocking: uses a simple map lookup to resolve pending promises.
   */
  async sendMessage(jid: string, content: string): Promise<void> {
    const entry = this.pending.get(jid);
    if (entry === undefined) {
      this.logger?.debug('api sendMessage: no pending request', { jid });
      return;
    }

    this.logger?.debug('api sendMessage: delivering response', {
      jid,
      content_len: content.length,
    });

    entry.resolve(content);
  }

  // ---------------------------------------------------------------------------
  // ChannelAdapter — getJIDPrefix / isConnected / onMessage / onMetadata
  // ---------------------------------------------------------------------------

  getJIDPrefix(): string {
    return API_PREFIX;
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
  // handleChat — Fastify route handler for POST /api/chat
  // ---------------------------------------------------------------------------

  /**
   * Accepts POST /api/chat with body { "content": "..." }, blocks until the
   * agent responds or the request times out, and returns
   * { "data": { "response": "..." } } on success.
   *
   * Error responses:
   *   503 CHANNEL_UNAVAILABLE  — channel not connected
   *   400 INVALID_REQUEST      — missing / empty content
   *   408 TIMEOUT              — no agent response within timeoutMs
   *   503 CHANNEL_DISCONNECTED — channel disconnected while waiting
   *
   * Fastify route handler for POST /api/chat.
   */
  handleChat(request: APIFastifyRequest, reply: APIFastifyReply): void {
    // (1) Check connected before parsing body
    if (!this.connected) {
      reply.code(503).send(
        apiError('CHANNEL_UNAVAILABLE', 'chat channel is not connected'),
      );
      return;
    }

    // (2) Validate body — Fastify has already parsed JSON at this point
    if (!isChatRequestBody(request.body)) {
      reply.code(400).send(
        apiError('INVALID_REQUEST', 'invalid request body'),
      );
      return;
    }

    const body = request.body;

    if (body.content.trim() === '') {
      reply.code(400).send(
        apiError('INVALID_REQUEST', 'content must not be empty'),
      );
      return;
    }

    // (3) Double-check connected after body parse (race: disconnect between
    //     check (1) and registration of the pending entry)
    if (!this.connected) {
      reply.code(503).send(
        apiError('CHANNEL_UNAVAILABLE', 'chat channel is not connected'),
      );
      return;
    }

    // (4) Generate unique JID
    this.counter += 1;
    const jid = `${API_PREFIX}:${this.counter}`;

    this.logger?.debug('api chat request received', { jid, content_len: body.content.length });

    // (5) Register pending entry and start response race
    const responsePromise = new Promise<string>((resolve, reject) => {
      this.pending.set(jid, { resolve, reject });
    });

    // (6) Start timeout
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new TimeoutError());
      }, this.timeoutMs);
    });

    // (7) Dispatch to router via onMessage callback (synchronous fire-and-forget)
    if (this.messageCallback !== null) {
      this.messageCallback(jid, body.content);
    }

    // (8) Race: response vs timeout
    Promise.race([responsePromise, timeoutPromise])
      .then((content: string) => {
        this.logger?.debug('api chat response received', {
          jid,
          response_len: content.length,
        });
        const success: ChatSuccessResponse = { data: { response: content } };
        reply.code(200).send(success);
      })
      .catch((err: unknown) => {
        if (err instanceof TimeoutError) {
          this.logger?.debug('api chat request timed out', { jid });
          reply.code(408).send(apiError('TIMEOUT', 'response timed out'));
        } else if (err instanceof Error && err.message === 'channel disconnected') {
          this.logger?.debug('api chat channel closed while waiting', { jid });
          reply.code(503).send(
            apiError('CHANNEL_DISCONNECTED', 'channel disconnected while waiting'),
          );
        } else {
          this.logger?.error('api chat unexpected error', {
            jid,
            error: err instanceof Error ? err.message : String(err),
          });
          reply.code(500).send(apiError('INTERNAL_ERROR', 'unexpected error'));
        }
      })
      .finally(() => {
        // Clean up timeout handle and pending entry
        if (timeoutHandle !== null) {
          clearTimeout(timeoutHandle);
        }
        this.pending.delete(jid);
      });
  }
}

// ---------------------------------------------------------------------------
// TimeoutError — sentinel for distinguishing timeout from disconnect
// ---------------------------------------------------------------------------

/** Sentinel error used internally to distinguish timeout from disconnect. */
class TimeoutError extends Error {
  constructor() {
    super('timeout');
    this.name = 'TimeoutError';
    Object.setPrototypeOf(this, TimeoutError.prototype);
  }
}

// ---------------------------------------------------------------------------
// apiError — builds a JSON error response body
// ---------------------------------------------------------------------------

/**
 * Builds a JSON error response body matching the api package format:
 * { "error": { "code": "...", "message": "..." } }
 */
function apiError(code: string, message: string): ChatErrorResponse {
  return { error: { code, message } };
}

// Silence unused variable warning — metadataCallback is stored but only
// invoked by callers who register via onMetadata(). onMetadata is part of the
// interface contract even if the API channel doesn't currently emit metadata events.
void (undefined as unknown as typeof APIChannel.prototype.onMetadata);
