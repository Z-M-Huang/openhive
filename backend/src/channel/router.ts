/**
 * OpenHive Backend - Message Router
 *
 * Connects messaging channel adapters to the main assistant via WebSocket.
 * Inbound messages create Tasks and dispatch them to the main team container.
 * Task results are routed back to the originating channel.
 *
 * Design notes:
 *   - No transactions — task creation and session upsert are sequential
 *     (best-effort).
 *   - HTML escaping is implemented inline (no standard library equivalent).
 *   - Node.js is single-threaded so plain Map needs no locking.
 */

import { v4 as uuidv4 } from 'uuid';

import type { ChannelAdapter, MessageRouter, WSHub, TaskStore, SessionStore, MessageStore } from '../domain/interfaces.js';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import type { Task, ChatSession, Message } from '../domain/types.js';
import { encodeMessage } from '../ws/protocol.js';
import { MsgTypeTaskDispatch } from '../ws/messages.js';
import type { TaskDispatchMsg, TaskResultMsg } from '../ws/messages.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_MESSAGE_LENGTH = 10000;

// ---------------------------------------------------------------------------
// Logger interface — minimal subset used internally
// ---------------------------------------------------------------------------

/**
 * Minimal logger interface required by Router.
 * Matches the shape of pino or any structured logger.
 */
export interface RouterLogger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// RouterConfig
// ---------------------------------------------------------------------------

/**
 * Configuration for a Router instance.
 */
export interface RouterConfig {
  /** WebSocket hub used to dispatch task messages to the main container. */
  wsHub: WSHub;
  /** Persistence for tasks. */
  taskStore: TaskStore;
  /** Persistence for chat sessions. */
  sessionStore: SessionStore;
  /** Persistence for chat messages. May be null to disable message persistence. */
  messageStore: MessageStore | null;
  /** Structured logger. */
  logger: RouterLogger;
  /** TID of the main assistant container. */
  mainTeamID: string;
  /** Slug of the main team (used for task team_slug fields). Defaults to 'main'. */
  mainTeamSlug?: string;
  /** AID of the main assistant agent. */
  mainAssistantAID: string;
  /**
   * Maximum allowed inbound message length in characters.
   * Defaults to 10000 when not set or <= 0.
   */
  maxMessageLength?: number;
}

// ---------------------------------------------------------------------------
// HTML escape helper
// ---------------------------------------------------------------------------

/**
 * htmlEscape replaces the five characters that have special meaning in XML/HTML
 * with their safe entity equivalents: &, <, >, ", '.
 *
 * Used to prevent XML injection in the agent prompt wrapper.
 */
function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&#34;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Router connects messaging channel adapters to the main assistant via
 * WebSocket. It implements the MessageRouter interface.
 *
 * Inbound flow:
 *   Channel → RouteInbound → TaskStore.create → SessionStore.upsert
 *            → MessageStore.create (inbound msg) → WSHub.sendToTeam
 *
 * Outbound flow (from handleTaskResult):
 *   TaskStore.update → SessionStore.upsert → MessageStore.create (outbound)
 *   → RouteOutbound → ChannelAdapter.sendMessage
 *
 * Implements the MessageRouter interface.
 */
export class Router implements MessageRouter {
  private readonly channels: Map<string, ChannelAdapter> = new Map();
  private readonly wsHub: WSHub;
  private readonly taskStore: TaskStore;
  private readonly sessionStore: SessionStore;
  private readonly messageStore: MessageStore | null;
  private readonly logger: RouterLogger;
  private readonly mainTeamID: string;
  private readonly mainTeamSlug: string;
  private readonly mainAssistantAID: string;
  private readonly maxMessageLength: number;

  constructor(cfg: RouterConfig) {
    this.wsHub = cfg.wsHub;
    this.taskStore = cfg.taskStore;
    this.sessionStore = cfg.sessionStore;
    this.messageStore = cfg.messageStore;
    this.logger = cfg.logger;
    this.mainTeamID = cfg.mainTeamID;
    this.mainTeamSlug = cfg.mainTeamSlug ?? 'main';
    this.mainAssistantAID = cfg.mainAssistantAID;
    this.maxMessageLength =
      cfg.maxMessageLength !== undefined && cfg.maxMessageLength > 0
        ? cfg.maxMessageLength
        : DEFAULT_MAX_MESSAGE_LENGTH;
  }

  // ---------------------------------------------------------------------------
  // registerChannel
  // ---------------------------------------------------------------------------

  /**
   * Registers a channel adapter. The adapter is keyed by its JID prefix.
   * Wires up the onMessage callback so inbound messages are automatically routed.
   * Throws ConflictError if a channel with the same prefix is already registered.
   * Throws ValidationError if the prefix is empty.
   *
   * Implements MessageRouter.registerChannel.
   */
  async registerChannel(adapter: ChannelAdapter): Promise<void> {
    const prefix = adapter.getJIDPrefix();
    if (prefix === '') {
      throw new ValidationError('prefix', 'channel prefix must not be empty');
    }

    if (this.channels.has(prefix)) {
      throw new ConflictError(
        'channel',
        `channel with prefix "${prefix}" is already registered`,
      );
    }

    // Wire up the onMessage callback before registering.
    adapter.onMessage((jid: string, content: string) => {
      this.routeInbound(jid, content).catch((err: unknown) => {
        this.logger.error('failed to route inbound message', {
          jid,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    this.channels.set(prefix, adapter);
    this.logger.info('channel registered', { prefix });
  }

  // ---------------------------------------------------------------------------
  // unregisterChannel
  // ---------------------------------------------------------------------------

  /**
   * Removes a registered channel adapter by prefix.
   * Throws NotFoundError if no channel with that prefix is registered.
   *
   * Implements MessageRouter.unregisterChannel.
   */
  async unregisterChannel(prefix: string): Promise<void> {
    if (!this.channels.has(prefix)) {
      throw new NotFoundError('channel', prefix);
    }

    this.channels.delete(prefix);
    this.logger.info('channel unregistered', { prefix });
  }

  // ---------------------------------------------------------------------------
  // routeInbound
  // ---------------------------------------------------------------------------

  /**
   * Handles an inbound message from a channel. Steps:
   *   1. Enforce maximum message length.
   *   2. Get or create a ChatSession for the JID.
   *   3. HTML-escape the content and wrap in XML.
   *   4. Create a Task record.
   *   5. Persist task + update session timestamp (sequential, best-effort).
   *   6. Persist inbound Message (best-effort — failure is logged, not thrown).
   *   7. Dispatch via WebSocket (best-effort — failure is logged, not thrown).
   *
   * Implements MessageRouter.routeInbound.
   */
  async routeInbound(jid: string, content: string): Promise<void> {
    // (1) Enforce message length limit.
    if (content.length > this.maxMessageLength) {
      throw new ValidationError(
        'content',
        `message exceeds maximum length of ${this.maxMessageLength} characters`,
      );
    }

    // (2) Get or create session.
    const session = await this.getOrCreateSession(jid);

    // (3) Escape and format.
    const escapedContent = htmlEscape(content);
    const channelType = extractPrefix(jid);
    const formatted = formatUserMessage(channelType, escapedContent);

    // (4) Build task.
    const taskID = uuidv4();
    const now = new Date();
    const task: Task = {
      id: taskID,
      team_slug: this.mainTeamSlug,
      agent_aid: session.agent_aid,
      jid,
      status: 'pending',
      prompt: formatted,
      created_at: now,
      updated_at: now,
      completed_at: null,
    };

    // (5) Persist task, then update session timestamp sequentially.
    await this.taskStore.create(task);

    session.last_timestamp = now;
    try {
      await this.sessionStore.upsert(session);
    } catch (err) {
      this.logger.warn('failed to update session after task creation', {
        jid,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // (6) Persist inbound message (best-effort).
    if (this.messageStore !== null) {
      const msg: Message = {
        id: uuidv4(),
        chat_jid: jid,
        role: 'user',
        content,
        timestamp: now,
      };
      try {
        await this.messageStore.create(msg);
      } catch (err) {
        this.logger.warn('failed to persist inbound message', {
          jid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // (7) Dispatch via WebSocket (best-effort).
    const dispatchMsg: TaskDispatchMsg = {
      task_id: taskID,
      agent_aid: session.agent_aid ?? this.mainAssistantAID,
      prompt: formatted,
      session_id: session.session_id,
    };

    try {
      const encoded = encodeMessage(MsgTypeTaskDispatch, dispatchMsg);
      await this.wsHub.sendToTeam(this.mainTeamID, encoded);
    } catch (err) {
      this.logger.warn(
        'failed to send task dispatch (container may not be connected)',
        {
          team_id: this.mainTeamID,
          error: err instanceof Error ? err.message : String(err),
        },
      );
      // Not returned — task is persisted and can be recovered.
    }

    this.logger.info('message routed inbound', {
      jid,
      task_id: taskID,
      channel: channelType,
    });
  }

  // ---------------------------------------------------------------------------
  // routeOutbound
  // ---------------------------------------------------------------------------

  /**
   * Routes a response to the correct channel based on the JID prefix.
   * Strips <agent_response> XML wrapper tags before sending.
   * Throws NotFoundError if no channel is registered for the JID prefix.
   *
   * Implements MessageRouter.routeOutbound.
   */
  async routeOutbound(jid: string, content: string): Promise<void> {
    this.logger.debug('routing outbound', { jid, content_len: content.length });

    const prefix = extractPrefix(jid);
    const adapter = this.channels.get(prefix);
    if (adapter === undefined) {
      throw new NotFoundError('channel', prefix);
    }

    const cleaned = stripResponseTags(content);
    await adapter.sendMessage(jid, cleaned);

    this.logger.info('message routed outbound', { jid, channel: prefix });
  }

  // ---------------------------------------------------------------------------
  // getChannels
  // ---------------------------------------------------------------------------

  /**
   * Returns a map of registered channel prefixes to their connection status.
   * Implements MessageRouter.getChannels.
   */
  getChannels(): Record<string, boolean> {
    const result: Record<string, boolean> = {};
    for (const [prefix, adapter] of this.channels.entries()) {
      result[prefix] = adapter.isConnected();
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // handleTaskResult
  // ---------------------------------------------------------------------------

  /**
   * Processes a task result received from a container via WebSocket.
   * Steps:
   *   1. Load task from DB and update its status/result/error.
   *   2. Update the session's lastAgentTimestamp.
   *   3. Persist outbound message (if completed with result content).
   *   4. Route response to originating channel.
   *      On task failure, send a generic user-facing message — NEVER expose
   *      internal error details.
   *
   * Implements MessageRouter.handleTaskResult.
   */
  async handleTaskResult(result: TaskResultMsg): Promise<void> {
    this.logger.debug('handling task result', {
      task_id: result.task_id,
      status: result.status,
      has_result: (result.result ?? '') !== '',
      has_error: (result.error ?? '') !== '',
    });

    // (1) Update task in DB.
    const task = await this.taskStore.get(result.task_id);
    const now = new Date();
    task.updated_at = now;
    task.completed_at = now;

    if (result.status === 'completed') {
      task.status = 'completed';
      task.result = result.result;
    } else {
      task.status = 'failed';
      task.error = result.error;
    }

    try {
      await this.taskStore.update(task);
    } catch (err) {
      this.logger.error('failed to update task', {
        task_id: result.task_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // (2) Update session with agent response timestamp.
    const jid = task.jid;
    if (jid === undefined || jid === '') {
      return;
    }

    try {
      const session = await this.sessionStore.get(jid);
      session.last_agent_timestamp = now;
      await this.sessionStore.upsert(session);
    } catch (err) {
      this.logger.warn('failed to update session after result', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // (3) Persist outbound message (best-effort).
    if (this.messageStore !== null) {
      const outboundContent = result.status === 'completed' ? (result.result ?? '') : '';
      if (outboundContent !== '') {
        const msg: Message = {
          id: uuidv4(),
          chat_jid: jid,
          role: 'assistant',
          content: outboundContent,
          timestamp: now,
        };
        try {
          await this.messageStore.create(msg);
        } catch (err) {
          this.logger.warn('failed to persist outbound message', {
            task_id: result.task_id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // (4) Route response to the originating channel.
    let responseContent: string;
    if (result.status === 'completed' && (result.result ?? '') !== '') {
      responseContent = result.result ?? '';
    } else if (result.status === 'failed') {
      // Log internal error but NEVER expose it to the user.
      this.logger.error('task failed', {
        task_id: result.task_id,
        internal_error: result.error ?? '',
      });
      responseContent = 'Sorry, I encountered an issue processing your request. Please try again.';
    } else {
      return;
    }

    try {
      await this.routeOutbound(jid, responseContent);
    } catch (err) {
      this.logger.error('failed to route response', {
        task_id: result.task_id,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // recoverInFlight
  // ---------------------------------------------------------------------------

  /**
   * Re-dispatches tasks that were in-flight when the server crashed.
   * Detects in-flight sessions by comparing last_timestamp > last_agent_timestamp.
   * For each such session, finds the pending/running task and re-dispatches it.
   *
   * Implements MessageRouter.recoverInFlight.
   */
  async recoverInFlight(): Promise<void> {
    let sessions: ChatSession[];
    try {
      sessions = await this.sessionStore.listAll();
    } catch (err) {
      throw new Error(
        `failed to list sessions for recovery: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let recovered = 0;

    for (const session of sessions) {
      if (session.last_timestamp <= session.last_agent_timestamp) {
        continue;
      }

      // This session has an in-flight message — find the pending/running task.
      let tasks: Task[];
      try {
        tasks = await this.taskStore.listByTeam(this.mainTeamSlug);
      } catch (err) {
        this.logger.warn('recovery: failed to list tasks', {
          jid: session.chat_jid,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      for (const task of tasks) {
        if (
          task.jid === session.chat_jid &&
          (task.status === 'pending' || task.status === 'running')
        ) {
          // Re-dispatch this task.
          const dispatchMsg: TaskDispatchMsg = {
            task_id: task.id,
            agent_aid: session.agent_aid ?? this.mainAssistantAID,
            prompt: task.prompt,
            session_id: session.session_id,
          };

          try {
            const encoded = encodeMessage(MsgTypeTaskDispatch, dispatchMsg);
            await this.wsHub.sendToTeam(this.mainTeamID, encoded);
            this.logger.info('recovery: re-dispatched in-flight task', {
              task_id: task.id,
              jid: session.chat_jid,
            });
            recovered++;
          } catch (err) {
            this.logger.warn('recovery: failed to re-dispatch task', {
              task_id: task.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }

          // Only re-dispatch the first matching task per session.
          break;
        }
      }
    }

    if (recovered > 0) {
      this.logger.info('in-flight recovery complete', { recovered });
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Gets an existing chat session for the JID, or creates a new one
   * with the main assistant as the default agent.
   * Returns the existing session or creates a new one with main assistant defaults.
   */
  private async getOrCreateSession(jid: string): Promise<ChatSession> {
    try {
      return await this.sessionStore.get(jid);
    } catch {
      // Session does not exist — create a new one.
      const session: ChatSession = {
        chat_jid: jid,
        channel_type: extractPrefix(jid),
        last_timestamp: new Date(0),
        last_agent_timestamp: new Date(0),
        agent_aid: this.mainAssistantAID,
      };
      await this.sessionStore.upsert(session);
      return session;
    }
  }
}

// ---------------------------------------------------------------------------
// Pure functions — exported for direct testing
// ---------------------------------------------------------------------------

/**
 * formatUserMessage wraps user content in an XML tag for agent consumption.
 * Content is already HTML-escaped before being passed here.
 *
 * @param channelType - The channel type prefix (e.g. "discord", "whatsapp").
 * @param escapedContent - HTML-escaped message content.
 * @returns XML-wrapped string.
 */
export function formatUserMessage(channelType: string, escapedContent: string): string {
  return `<user_message channel="${channelType}">${escapedContent}</user_message>`;
}

/**
 * stripResponseTags removes <agent_response> XML wrapper tags from agent
 * responses, returning only the inner content (trimmed).
 *
 * Handles both bare <agent_response> and tags with attributes
 * (e.g. <agent_response version="1">).
 *
 * @param content - Raw content from the agent, possibly wrapped in tags.
 * @returns Cleaned content with outer tags removed.
 */
export function stripResponseTags(content: string): string {
  // Remove opening <agent_response ...> tag if present.
  if (content.startsWith('<agent_response')) {
    const closeIdx = content.indexOf('>');
    if (closeIdx !== -1) {
      content = content.slice(closeIdx + 1);
      // Remove closing </agent_response> tag.
      const endIdx = content.lastIndexOf('</agent_response>');
      if (endIdx !== -1) {
        content = content.slice(0, endIdx);
      }
    }
  }
  return content.trim();
}

/**
 * extractPrefix gets the channel prefix from a JID (everything before the
 * first colon).
 *
 * Examples:
 *   "discord:123456"  → "discord"
 *   "whatsapp:+1234"  → "whatsapp"
 *   "nocolon"         → "nocolon"
 *
 * Exported for testing.
 */
export function extractPrefix(jid: string): string {
  const idx = jid.indexOf(':');
  if (idx !== -1) {
    return jid.slice(0, idx);
  }
  return jid;
}
