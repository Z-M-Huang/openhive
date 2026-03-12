import { ConflictError, NotFoundError } from '../domain/errors.js';
import type { InboundMessage, Router } from '../domain/index.js';

/** Route match type in priority order: exact > prefix > regex. */
export type RouteType = 'exact' | 'prefix' | 'regex';

interface KnownRoute {
  pattern: string;
  type: RouteType;
  teamSlug: string;
  compiledRegex?: RegExp;
}

/** Priority score: lower = higher priority. */
function typePriority(type: RouteType): number {
  switch (type) {
    case 'exact': return 0;
    case 'prefix': return 1;
    case 'regex': return 2;
  }
}

/**
 * Tier 2 callback — delegates routing to the main assistant (LLM judgment).
 * Returns the team slug chosen by the LLM.
 */
export type Tier2Handler = (message: InboundMessage) => Promise<string>;

/**
 * Two-tier message router.
 *
 * Tier 1: Deterministic config-defined routes (exact > prefix > regex).
 * Tier 2: LLM judgment via the main assistant (optional callback).
 */
export class RouterImpl implements Router {
  private readonly routes: KnownRoute[] = [];
  private tier2Handler: Tier2Handler | undefined;

  constructor(tier2Handler?: Tier2Handler) {
    this.tier2Handler = tier2Handler;
  }

  /**
   * Set or replace the Tier 2 handler (LLM judgment fallback).
   */
  setTier2Handler(handler: Tier2Handler): void {
    this.tier2Handler = handler;
  }

  /**
   * Register a deterministic Tier 1 route.
   *
   * Routes are stored in priority order (exact > prefix > regex).
   * If a pattern already exists, its target is updated.
   *
   * AC-L8-03: Conflict detection within same route type (exact, prefix, regex).
   * Different types are NOT conflicts - priority ordering resolves them.
   *
   * @param pattern - The route pattern
   * @param teamSlug - Target team slug
   * @param type - Match type (default: 'exact')
   */
  addKnownRoute(pattern: string, teamSlug: string, type: RouteType = 'exact'): void {
    // Check for duplicate pattern
    const existing = this.routes.find((r) => r.pattern === pattern);
    if (existing) {
      existing.teamSlug = teamSlug;
      existing.type = type;
      existing.compiledRegex = type === 'regex' ? new RegExp(pattern) : undefined;
      return;
    }

    // AC-L8-03: Check for conflicts within same route type only
    // Different types are resolved by priority ordering (exact > prefix > regex)
    for (const route of this.routes) {
      if (route.teamSlug === teamSlug) continue;
      if (route.type !== type) continue; // Different types = not a conflict

      // prefix vs prefix overlap: one is a prefix of the other
      if (type === 'prefix') {
        if (pattern.startsWith(route.pattern) || route.pattern.startsWith(pattern)) {
          throw new ConflictError(
            `Ambiguous route: prefix '${pattern}' overlaps with existing prefix '${route.pattern}' (team '${route.teamSlug}')`
          );
        }
      }

      // exact vs exact: same pattern already handled above (duplicate check)

      // regex vs regex: both patterns could match same string
      // Simple heuristic: test if either regex matches the other's pattern
      if (type === 'regex') {
        const newRegex = new RegExp(pattern);
        if (route.compiledRegex?.test(pattern) || newRegex.test(route.pattern)) {
          throw new ConflictError(
            `Ambiguous route: regex '${pattern}' overlaps with existing regex '${route.pattern}' (team '${route.teamSlug}')`
          );
        }
      }
    }

    const entry: KnownRoute = {
      pattern,
      type,
      teamSlug,
      compiledRegex: type === 'regex' ? new RegExp(pattern) : undefined,
    };

    // Insert in priority order
    const priority = typePriority(type);
    const insertIdx = this.routes.findIndex((r) => typePriority(r.type) > priority);
    if (insertIdx === -1) {
      this.routes.push(entry);
    } else {
      this.routes.splice(insertIdx, 0, entry);
    }
  }

  removeKnownRoute(pattern: string): void {
    const idx = this.routes.findIndex((r) => r.pattern === pattern);
    if (idx !== -1) {
      this.routes.splice(idx, 1);
    }
  }

  listKnownRoutes(): Array<{ pattern: string; teamSlug: string }> {
    return this.routes.map((r) => ({ pattern: r.pattern, teamSlug: r.teamSlug }));
  }

  /**
   * Route an inbound message.
   *
   * 1. Tier 1: check known routes in priority order (exact > prefix > regex).
   *    Matches against message content and chatJid.
   * 2. Tier 2: if no match, delegate to LLM handler.
   * 3. Throws NotFoundError if neither tier resolves.
   */
  async route(message: InboundMessage): Promise<string> {
    // Tier 1: deterministic routing
    for (const route of this.routes) {
      if (this.matches(route, message)) {
        return route.teamSlug;
      }
    }

    // Tier 2: LLM judgment
    if (this.tier2Handler) {
      return this.tier2Handler(message);
    }

    throw new NotFoundError(
      `No route found for message '${message.id}' and no Tier 2 handler configured`
    );
  }

  private matches(route: KnownRoute, message: InboundMessage): boolean {
    switch (route.type) {
      case 'exact':
        return message.content === route.pattern || message.chatJid === route.pattern;
      case 'prefix':
        return message.content.startsWith(route.pattern) || message.chatJid.startsWith(route.pattern);
      case 'regex':
        return route.compiledRegex!.test(message.content);
      default:
        return false;
    }
  }
}
