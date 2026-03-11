/**
 * Channel adapter interface and base class.
 *
 * Defines the abstraction layer for all messaging platforms (Discord, Slack,
 * WhatsApp, CLI, API). Concrete adapters extend {@link BaseChannelAdapter}
 * and implement platform-specific connection, disconnection, message sending,
 * and message receiving logic.
 *
 * The {@link ChannelAdapter} interface is defined in domain/interfaces.ts
 * and re-exported here for convenience. The {@link BaseChannelAdapter}
 * abstract class provides:
 *   - A protected list of message handlers.
 *   - A concrete {@link onMessage} implementation that registers handlers.
 *   - Abstract stubs for {@link connect}, {@link disconnect}, and
 *     {@link sendMessage} that concrete adapters must implement.
 *
 * Concrete adapters (e.g., DiscordAdapter) call {@link notifyHandlers}
 * when an inbound message arrives, which fans out to all registered handlers.
 *
 * @example
 * ```ts
 * class DiscordAdapter extends BaseChannelAdapter {
 *   async connect(): Promise<void> { ... }
 *   async disconnect(): Promise<void> { ... }
 *   async sendMessage(msg: OutboundMessage): Promise<void> { ... }
 * }
 *
 * const adapter = new DiscordAdapter();
 * adapter.onMessage(async (msg) => console.log('Received:', msg));
 * await adapter.connect();
 * ```
 */

import type {
  ChannelAdapter,
  OutboundMessage,
  InboundMessage,
  MessageHandler,
} from '../domain/interfaces.js';

// Re-export the canonical ChannelAdapter interface from the domain layer.
export type { ChannelAdapter } from '../domain/interfaces.js';

// Re-export supporting types used by channel adapters.
export type { OutboundMessage, InboundMessage, MessageHandler };

/**
 * Abstract base class for messaging channel adapters.
 *
 * Provides shared handler management so that concrete adapters only need
 * to implement platform-specific connect/disconnect/send logic. Inbound
 * messages are delivered to registered handlers via {@link notifyHandlers}.
 *
 * Subclasses must implement:
 *   - {@link connect} — establish platform connection (e.g., Discord gateway).
 *   - {@link disconnect} — tear down the connection gracefully.
 *   - {@link sendMessage} — deliver an outbound message to the platform.
 *
 * Subclasses should call {@link notifyHandlers} when a message arrives
 * from the platform, which fans out to all handlers registered via
 * {@link onMessage}.
 */
export abstract class BaseChannelAdapter implements ChannelAdapter {
  /** Registered message handlers. Subclasses call notifyHandlers to invoke them. */
  protected readonly _handlers: MessageHandler[] = [];

  /**
   * Establish a connection to the messaging platform.
   *
   * Concrete adapters implement platform-specific connection logic
   * (e.g., Discord bot login, WebSocket connect, HTTP long-poll).
   */
  abstract connect(): Promise<void>;

  /**
   * Gracefully disconnect from the messaging platform.
   *
   * Concrete adapters implement platform-specific teardown (e.g.,
   * close gateway connection, flush pending messages).
   */
  abstract disconnect(): Promise<void>;

  /**
   * Send a message through the messaging platform.
   *
   * @param msg - The outbound message to deliver.
   */
  abstract sendMessage(msg: OutboundMessage): Promise<void>;

  /**
   * Register a handler for inbound messages.
   *
   * Multiple handlers can be registered. Each handler is invoked
   * (in registration order) when {@link notifyHandlers} is called
   * by the concrete adapter.
   *
   * @param handler - Async callback invoked with each inbound message.
   */
  onMessage(handler: MessageHandler): void {
    this._handlers.push(handler);
  }

  /**
   * Notify all registered handlers of an inbound message.
   *
   * Concrete adapters call this method when a message arrives from
   * the platform. Handlers are invoked sequentially in registration
   * order. If a handler throws, the error propagates and remaining
   * handlers are not called (fail-fast behavior — concrete adapters
   * should catch and log errors as appropriate).
   *
   * @param msg - The inbound message received from the platform.
   */
  protected async notifyHandlers(msg: InboundMessage): Promise<void> {
    for (const handler of this._handlers) {
      await handler(msg);
    }
  }
}
