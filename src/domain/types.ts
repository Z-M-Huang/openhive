/**
 * Core domain types for OpenHive v3.
 */

// ── Enums ──────────────────────────────────────────────────────────────────

export type TaskType = 'delegate' | 'trigger' | 'escalation' | 'bootstrap';

export type TaskPriority = 'low' | 'normal' | 'high' | 'critical';

export interface TaskOptions {
  readonly maxTurns?: number;
}

export enum TeamStatus {
  Active = 'active',
  Idle = 'idle',
  Shutdown = 'shutdown',
}

export enum TaskStatus {
  Pending = 'pending',
  Running = 'running',
  Completed = 'completed',
  Failed = 'failed',
}

// ── Config Types ───────────────────────────────────────────────────────────

export interface TeamScope {
  readonly accepts: readonly string[];
  readonly rejects: readonly string[];
}

export interface BrowserConfig {
  readonly allowed_domains?: readonly string[];
  readonly timeout_ms?: number;
}

export interface TeamConfig {
  readonly name: string;
  readonly parent: string | null;
  readonly description: string;
  /** @deprecated Scope is now stored in SQLite scope_keywords table. */
  readonly scope?: TeamScope;
  readonly allowed_tools: readonly string[];
  readonly mcp_servers: readonly string[];
  readonly provider_profile: string;
  readonly maxTurns: number;
  readonly credentials?: Readonly<Record<string, string>>;
  readonly browser?: BrowserConfig;
  readonly memory?: { readonly embedding_provider_profile?: string };
}

export type TriggerState = 'pending' | 'active' | 'disabled';

export interface TriggerConfig {
  readonly name: string;
  readonly type: 'schedule' | 'keyword' | 'message';
  readonly config: Record<string, unknown>;
  readonly team: string;
  readonly task: string;
  readonly skill?: string;
  readonly state?: TriggerState;
  readonly maxTurns?: number;
  readonly failureThreshold?: number;
  readonly consecutiveFailures?: number;
  readonly disabledReason?: string;
  /** Channel that created this trigger — used for notification routing when the trigger fires. */
  readonly sourceChannelId?: string;
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
