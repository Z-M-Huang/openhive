/**
 * Core domain types for OpenHive v0.5.0.
 */

// ── Enums ──────────────────────────────────────────────────────────────────

export type TaskType = 'delegate' | 'trigger' | 'escalation' | 'bootstrap';

export type TaskPriority = 'low' | 'normal' | 'high' | 'critical';

export interface TaskOptions {
  readonly maxSteps?: number;
  readonly subagent?: string;
}

export enum TeamStatus {
  Active = 'active',
  Idle = 'idle',
  Shutdown = 'shutdown',
}

export enum TaskStatus {
  Pending = 'pending',
  Running = 'running',
  Done = 'done',
  Failed = 'failed',
  Cancelled = 'cancelled',
}

// ── Config Types ───────────────────────────────────────────────────────────

export interface BrowserConfig {
  readonly allowed_domains?: readonly string[];
  readonly timeout_ms?: number;
}

/**
 * Token-bucket limiter (ADR-41).
 *
 * Per wiki ([[Team-Configuration#Rate Limit Buckets]]), buckets are a map
 * keyed on a caller-supplied `rate_limit_key` (passed to `web_fetch` etc.).
 * The value carries only `rps` and `burst`; the key is the bucket identity.
 */
export interface RateLimitBucket {
  readonly rps: number;
  readonly burst: number;
}

export interface TeamConfig {
  readonly name: string;
  readonly parent: string | null;
  readonly description: string;
  readonly allowed_tools: readonly string[];
  readonly provider_profile: string;
  readonly maxSteps: number;
  readonly credentials?: Readonly<Record<string, string>>;
  readonly browser?: BrowserConfig;
  readonly memory?: { readonly embedding_provider_profile?: string };
  /** ADR-41: maximum concurrent daily-class ops per team (default 5). */
  readonly max_concurrent_daily_ops?: number;
  /** ADR-41: per-domain token bucket limits, keyed by bucket name. */
  readonly rate_limit_buckets?: Readonly<Record<string, RateLimitBucket>>;
}

export type TriggerState = 'pending' | 'active' | 'disabled';

export interface TriggerConfig {
  readonly name: string;
  readonly type: 'schedule' | 'keyword' | 'message' | 'window';
  readonly config: Record<string, unknown>;
  readonly team: string;
  readonly task: string;
  readonly subagent?: string;
  readonly state?: TriggerState;
  readonly maxSteps?: number;
  readonly failureThreshold?: number;
  readonly consecutiveFailures?: number;
  readonly disabledReason?: string;
  /** Channel that created this trigger — used for notification routing when the trigger fires. */
  readonly sourceChannelId?: string;
  readonly overlapPolicy?: OverlapPolicy;
  readonly overlapCount?: number;
  readonly activeTaskId?: string | null;
}

export type OverlapPolicy = 'skip-then-replace' | 'always-skip' | 'always-replace' | 'allow';

/**
 * Window trigger configuration (ADR-42).
 *
 * Per wiki (Architecture-Decisions.md §ADR-42 and Triggers.md §window):
 *  - `watch_window`        — cron expression defining when polling is active (optional)
 *  - `tick_interval_ms`    — cadence within the window (default 30000 ms)
 *  - `max_tokens_per_window` — hard cap on total token consumption per window occurrence
 *  - `max_ticks_per_window`  — hard cap on number of ticks per window occurrence
 *  - `overlap_policy`        — reuses existing trigger overlap policy
 */
export interface WindowTriggerConfig {
  readonly tick_interval_ms?: number;
  readonly watch_window?: string;
  readonly max_tokens_per_window?: number;
  readonly max_ticks_per_window?: number;
  readonly overlap_policy?: OverlapPolicy;
}

export interface ProviderProfile {
  readonly name: string;
  readonly type: 'api' | 'oauth';
  readonly provider?: 'anthropic' | 'openai';
  readonly api_url?: string;
  readonly api_key?: string;
  readonly model?: string;
  readonly oauth_token_env?: string;
  readonly context_window?: number;
}

// ── Runtime Types ──────────────────────────────────────────────────────────

export interface EscalationCorrelation {
  readonly correlationId: string;
  readonly sourceTeam: string;
  readonly targetTeam: string;
  readonly taskId: string | null;
  readonly status: string;
  readonly createdAt: string;
}

export interface TaskEntry {
  readonly id: string;
  readonly teamId: string;
  readonly task: string;
  readonly priority: TaskPriority;
  readonly type: TaskType;
  readonly status: TaskStatus;
  readonly createdAt: string;
  readonly correlationId: string | null;
  readonly result: string | null;
  readonly durationMs: number | null;
  readonly options: TaskOptions | null;
  readonly sourceChannelId: string | null;
  readonly topicId?: string | null;
}

export interface LogEntry {
  readonly id: string;
  readonly level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'audit';
  readonly message: string;
  readonly timestamp: number;
  readonly source: string;
  readonly metadata?: Record<string, unknown>;
}

export interface OrgTreeNode {
  readonly teamId: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly status: TeamStatus;
  readonly agents: readonly string[];
  readonly children: readonly OrgTreeNode[];
}

// ── Topic Types ───────────────────────────────────────────────────────────

export type TopicState = 'active' | 'idle' | 'done';

export interface TopicEntry {
  readonly id: string;
  readonly channelId: string;
  readonly name: string;
  readonly description: string;
  readonly state: TopicState;
  readonly createdAt: string;
  readonly lastActivity: string;
}

// ── Memory Types ──────────────────────────────────────────────────────────

export type MemoryType = 'identity' | 'lesson' | 'decision' | 'context' | 'reference' | 'historical';

export const MEMORY_TYPE_ALIASES: Record<string, MemoryType> = {
  warning: 'lesson',
  insight: 'lesson',
  learning: 'lesson',
  core: 'identity',
  self: 'identity',
  commitment: 'decision',
  choice: 'decision',
  note: 'decision',
  active: 'context',
  background: 'context',
  pointer: 'reference',
  link: 'reference',
  archive: 'historical',
  past: 'historical',
};

export const INJECTED_TYPES = ['identity', 'lesson', 'decision', 'context'] as const;

export interface MemoryEntry {
  readonly id: number;
  readonly team_name: string;
  readonly key: string;
  readonly content: string;
  readonly type: MemoryType;
  readonly is_active: boolean;
  readonly supersedes_id: number | null;
  readonly supersede_reason: string | null;
  readonly updated_by: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface MemorySearchResult {
  readonly key: string;
  readonly snippet: string;
  readonly score: number;
  readonly type: MemoryType;
  readonly is_active: boolean;
  readonly source: 'hybrid' | 'keyword';
}

// ── Vault Types ──────────────────────────────────────────────────────────

export interface VaultEntry {
  readonly id: number;
  readonly teamName: string;
  readonly key: string;
  readonly value: string;
  readonly isSecret: boolean;
  readonly updatedBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
