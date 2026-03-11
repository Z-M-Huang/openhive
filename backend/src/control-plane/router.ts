import type { InboundMessage, Router } from '../domain/index.js';

/**
 * Two-tier message router — routes inbound channel messages to the correct team.
 *
 * **Tier 1: Deterministic routing (config-defined, instant, no LLM)**
 *
 * Known routes are pattern-based rules registered at runtime via {@link addKnownRoute}.
 * Patterns are matched against the inbound message content and/or chat JID.
 * When a message matches a known route, it is immediately dispatched to the
 * associated team — no LLM call is needed. This tier handles the common case
 * where the user has established teams with clear responsibilities.
 *
 * Examples of known route patterns:
 * - Chat JID exact match (a specific Discord channel → a specific team)
 * - Keyword prefix match (messages starting with "/deploy" → deploy-team)
 * - Regex patterns for structured commands
 *
 * Known routes are stored in-memory and rebuilt on startup from persisted
 * configuration. Routes are ordered by specificity — more specific patterns
 * are checked before broader ones.
 *
 * **Tier 2: LLM judgment (novel/ambiguous messages via main assistant)**
 *
 * When no Tier 1 route matches, the message is forwarded to the main assistant
 * agent for LLM-based routing. The main assistant analyzes the message content,
 * considers the current team topology and their purposes, and decides which
 * team should handle the request — or whether to handle it directly.
 *
 * The LLM routing path is slower (requires an inference call) but handles:
 * - Novel requests that don't match any existing pattern
 * - Ambiguous messages that could go to multiple teams
 * - Meta-requests (e.g., "create a new team for X")
 * - Conversational context that requires understanding prior messages
 *
 * After the LLM routes a message, the router may optionally learn from the
 * decision and add a new Tier 1 route for future similar messages (future feature).
 *
 * **Integration:**
 * - Used by the {@link MessageRouter} to determine the target team for inbound messages
 * - Tier 2 requires access to the main assistant's agent executor
 * - Route changes are published to the EventBus as `org_chart.updated` events
 */
export class RouterImpl implements Router {
  /**
   * Route an inbound message to the appropriate team.
   *
   * Evaluation order:
   * 1. Check Tier 1 known routes (pattern match against message content/JID)
   * 2. If no match, fall through to Tier 2 (LLM judgment via main assistant)
   * 3. Return the target team slug
   *
   * @param message - The inbound channel message to route
   * @returns The team slug that should handle this message
   * @throws NotFoundError if no route can be determined (neither tier matched)
   */
  route(_message: InboundMessage): Promise<string> {
    throw new Error('Not implemented');
  }

  /**
   * Register a deterministic Tier 1 route.
   *
   * Patterns are matched in order of specificity (exact > prefix > regex).
   * If a pattern already exists, its target team slug is updated.
   *
   * @param pattern - The route pattern (exact string, prefix, or regex)
   * @param teamSlug - The target team slug for messages matching this pattern
   */
  addKnownRoute(_pattern: string, _teamSlug: string): void {
    throw new Error('Not implemented');
  }

  /**
   * Remove a Tier 1 route by its pattern.
   *
   * No-op if the pattern does not exist.
   *
   * @param pattern - The route pattern to remove
   */
  removeKnownRoute(_pattern: string): void {
    throw new Error('Not implemented');
  }

  /**
   * List all registered Tier 1 routes.
   *
   * @returns Array of known routes with their patterns and target team slugs
   */
  listKnownRoutes(): Array<{ pattern: string; teamSlug: string }> {
    throw new Error('Not implemented');
  }
}
