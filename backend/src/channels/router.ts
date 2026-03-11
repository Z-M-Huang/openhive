/**
 * Message router for inbound channel messages.
 *
 * Implements the {@link MessageRouter} interface from the domain layer,
 * mapping incoming channel messages to the appropriate team/agent using
 * two-tier routing:
 *
 * 1. **Known-route lookup** — Checks registered chat-JID-to-team mappings
 *    first. If a mapping exists for the inbound message's `chatJid`, the
 *    message is routed directly to the mapped team without LLM involvement.
 *
 * 2. **LLM fallback** — When no known route matches, the router delegates
 *    to the {@link Router} (orchestrator-level) which uses an LLM call to
 *    classify the message intent and select the best team. The result is
 *    optionally cached as a known route for future messages on the same JID.
 *
 * After routing, the router:
 *   - Stores the inbound message in the {@link MessageStore} for history.
 *   - Advances the per-session cursor so the channel adapter knows which
 *     messages have been processed.
 *   - Dispatches the message content to the resolved team's lead agent.
 *
 * Channel adapters are registered/unregistered dynamically. Each adapter's
 * {@link ChannelAdapter.onMessage} handler is wired to call
 * {@link routeMessage} so that all inbound messages flow through this
 * single routing layer.
 *
 * @example
 * ```ts
 * const router = new MessageRouterImpl();
 * router.registerChannel(ChannelType.Discord, discordAdapter);
 * router.addMapping('discord:123:456', 'weather-team');
 * // Inbound messages from discord:123:456 now route to weather-team.
 * ```
 *
 * @see {@link MessageRouter} in domain/interfaces.ts for the interface contract.
 * @see {@link Router} in domain/interfaces.ts for the orchestrator-level router.
 * @see Architecture.md section on message routing for the two-tier design.
 */

import type {
  MessageRouter,
  ChannelAdapter,
  InboundMessage,
} from '../domain/index.js';

import type { ChannelType } from '../domain/index.js';

/**
 * Concrete implementation of the {@link MessageRouter} interface.
 *
 * Routes inbound channel messages to the appropriate team/agent using
 * two-tier routing (known routes first, LLM fallback second). Stores
 * processed messages in the database and advances the per-session cursor.
 *
 * All methods currently throw — implementation is deferred to the
 * messaging layer build-out (L7+).
 */
export class MessageRouterImpl implements MessageRouter {
  /**
   * Route an inbound message to the appropriate team/agent.
   *
   * Performs two-tier routing:
   * 1. Checks the known-route map for an exact `chatJid` match.
   * 2. Falls back to the orchestrator-level {@link Router} for LLM-based
   *    intent classification if no known route exists.
   *
   * After resolving the target team, the method:
   * - Persists the message via {@link MessageStore.create}.
   * - Advances the session cursor so the channel adapter tracks progress.
   * - Dispatches the message content to the team's lead agent.
   *
   * @param msg - The inbound message received from a channel adapter.
   * @throws Error — Not implemented.
   */
  async routeMessage(msg: InboundMessage): Promise<void> {
    void msg;
    throw new Error('Not implemented');
  }

  /**
   * Register a channel adapter for a given channel type.
   *
   * Wires the adapter's {@link ChannelAdapter.onMessage} handler to call
   * {@link routeMessage}, so all inbound messages from this channel flow
   * through the two-tier routing pipeline.
   *
   * Only one adapter per channel type is supported. Registering a second
   * adapter for the same type replaces the previous one.
   *
   * @param channelType - The channel type (e.g., `ChannelType.Discord`).
   * @param adapter - The channel adapter instance to register.
   * @throws Error — Not implemented.
   */
  registerChannel(channelType: ChannelType, adapter: ChannelAdapter): void {
    void channelType;
    void adapter;
    throw new Error('Not implemented');
  }

  /**
   * Unregister a channel adapter for a given channel type.
   *
   * Removes the adapter and its message handler. Messages from this channel
   * type will no longer be routed until a new adapter is registered.
   *
   * @param channelType - The channel type to unregister.
   * @throws Error — Not implemented.
   */
  unregisterChannel(channelType: ChannelType): void {
    void channelType;
    throw new Error('Not implemented');
  }

  /**
   * Add a known chat-JID-to-team mapping for direct routing.
   *
   * Messages arriving on the specified `chatJid` will be routed directly
   * to the given team without invoking the LLM fallback. This is the
   * first tier of the two-tier routing system.
   *
   * Mappings can be added at startup (from persisted session data) or
   * dynamically when the LLM fallback resolves a new JID for the first time.
   *
   * @param chatJid - The chat JID to map (e.g., `discord:123:456`).
   * @param teamSlug - The target team slug (e.g., `weather-team`).
   * @throws Error — Not implemented.
   */
  addMapping(chatJid: string, teamSlug: string): void {
    void chatJid;
    void teamSlug;
    throw new Error('Not implemented');
  }
}
