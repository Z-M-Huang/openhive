import type {
  OrgChart,
  MCPRegistry,
  ToolCallStore,
  Logger,
} from '../domain/interfaces.js';
import type { AgentRole } from '../domain/enums.js';
import {
  AccessDeniedError,
  NotFoundError,
  RateLimitedError,
} from '../domain/errors.js';

/** LRU-TTL cache entry for tool call dedup (AC-L8-18). */
interface CacheEntry {
  result: Record<string, unknown>;
  expiresAt: number;
}

/** Sliding-window rate limiter per agent (AC-L8-06). */
interface RateLimiter {
  timestamps: number[];
}

/** Rate limit config per tool category. */
interface RateLimitConfig {
  windowMs: number;
  maxCalls: number;
}

const RATE_LIMITS: Record<string, RateLimitConfig> = {
  create_team: { windowMs: 60_000, maxCalls: 5 },
  create_agent: { windowMs: 60_000, maxCalls: 5 },
  dispatch_subtask: { windowMs: 60_000, maxCalls: 30 },
  create_task: { windowMs: 60_000, maxCalls: 30 },
};

const DEDUP_TTL_MS = 5 * 60 * 1000;
const DEDUP_MAX_SIZE = 50_000;

/**
 * Handles tool call processing: dedup, authorization, rate limiting, execution, caching.
 */
export class ToolCallDispatcher {
  private readonly orgChart: OrgChart;
  private readonly mcpRegistry: MCPRegistry;
  private readonly toolCallStore: ToolCallStore;
  private readonly logger: Logger;
  private readonly handlers: Map<string, (args: Record<string, unknown>, agentAid: string, teamSlug: string) => Promise<Record<string, unknown>>>;

  /** LRU dedup cache keyed by call_id. */
  private readonly dedupCache = new Map<string, CacheEntry>();

  /** Per-agent rate limiters, lazy-initialized. */
  private readonly rateLimiters = new Map<string, RateLimiter>();

  constructor(deps: {
    orgChart: OrgChart;
    mcpRegistry: MCPRegistry;
    toolCallStore: ToolCallStore;
    logger: Logger;
    handlers: Map<string, (args: Record<string, unknown>, agentAid: string, teamSlug: string) => Promise<Record<string, unknown>>>;
  }) {
    this.orgChart = deps.orgChart;
    this.mcpRegistry = deps.mcpRegistry;
    this.toolCallStore = deps.toolCallStore;
    this.logger = deps.logger;
    this.handlers = deps.handlers;
  }

  async handleToolCall(
    agentAid: string,
    toolName: string,
    args: Record<string, unknown>,
    callId: string,
  ): Promise<Record<string, unknown>> {
    // 1. Dedup check
    const cached = this.dedupCache.get(callId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }

    // 2. Authorize via OrgChart + MCPRegistry
    const agent = this.orgChart.getAgent(agentAid);
    if (!agent) {
      throw new NotFoundError(`Agent '${agentAid}' not found`);
    }
    const role = agent.role as AgentRole;
    if (!this.mcpRegistry.isAllowed(toolName, role)) {
      throw new AccessDeniedError(
        `Agent '${agentAid}' (role: ${role}) not authorized for '${toolName}'`
      );
    }

    // 3. Rate limit check
    const rateConfig = RATE_LIMITS[toolName];
    if (rateConfig) {
      this.checkRateLimit(agentAid, toolName, rateConfig);
    }

    // 4. Execute handler
    const handler = this.handlers.get(toolName);
    if (!handler) {
      throw new NotFoundError(`Tool '${toolName}' not found`);
    }

    const startTime = Date.now();
    const result = await handler(args, agentAid, agent.teamSlug);

    // 5. Cache result
    this.cacheResult(callId, result);

    // 6. Log to ToolCallStore
    const durationMs = Date.now() - startTime;
    try {
      await this.toolCallStore.create({
        id: 0,
        log_entry_id: 0,
        tool_use_id: callId,
        tool_name: toolName,
        agent_aid: agentAid,
        team_slug: agent.teamSlug,
        task_id: '',
        params: JSON.stringify(args),
        result_summary: JSON.stringify(result).slice(0, 1000),
        error: '',
        duration_ms: durationMs,
        created_at: Date.now(),
      });
    } catch {
      this.logger.warn('Failed to log tool call', { call_id: callId });
    }

    return result;
  }

  /** Clean up rate limiter state when an agent is removed (AC-L8-06). */
  cleanupAgent(agentAid: string): void {
    this.rateLimiters.delete(agentAid);
  }

  private checkRateLimit(agentAid: string, toolName: string, config: RateLimitConfig): void {
    const key = agentAid;
    let limiter = this.rateLimiters.get(key);
    if (!limiter) {
      limiter = { timestamps: [] };
      this.rateLimiters.set(key, limiter);
    }

    const now = Date.now();
    const windowStart = now - config.windowMs;

    // Prune expired timestamps
    limiter.timestamps = limiter.timestamps.filter((t) => t > windowStart);

    if (limiter.timestamps.length >= config.maxCalls) {
      throw new RateLimitedError(
        `Rate limit exceeded for '${toolName}' by agent '${agentAid}': ` +
        `${config.maxCalls} calls per ${config.windowMs / 1000}s`
      );
    }

    limiter.timestamps.push(now);
  }

  private cacheResult(callId: string, result: Record<string, unknown>): void {
    // Evict oldest if at capacity
    if (this.dedupCache.size >= DEDUP_MAX_SIZE) {
      const firstKey = this.dedupCache.keys().next().value;
      if (firstKey !== undefined) {
        this.dedupCache.delete(firstKey);
      }
    }

    this.dedupCache.set(callId, {
      result,
      expiresAt: Date.now() + DEDUP_TTL_MS,
    });
  }
}
