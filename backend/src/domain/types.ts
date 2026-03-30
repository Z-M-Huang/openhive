/**
 * Core domain types for OpenHive v3.
 */

// ── Enums ──────────────────────────────────────────────────────────────────

export enum TaskPriority {
  Critical = 'critical',
  High = 'high',
  Normal = 'normal',
  Low = 'low',
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
  readonly status: TaskStatus;
  readonly createdAt: string;
  readonly correlationId: string | null;
  readonly result: string | null;
  readonly durationMs: number | null;
  readonly options: string | null;
  readonly sourceChannelId: string | null;
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
