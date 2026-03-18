/**
 * Domain enums for OpenHive.
 *
 * Uses `as const` objects for runtime values and derived union types.
 * All values match the canonical definitions in Architecture.md,
 * Database-Schema.md, WebSocket-Protocol.md, and MCP-Tools.md.
 */

// ---------------------------------------------------------------------------
// Task Status
// ---------------------------------------------------------------------------

/** Canonical task states from the task state machine (Architecture.md). */
export const TaskStatus = {
  Pending: 'pending',
  Active: 'active',
  Completed: 'completed',
  Failed: 'failed',
  Escalated: 'escalated',
  Cancelled: 'cancelled',
} as const;

export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

// ---------------------------------------------------------------------------
// Log Level
// ---------------------------------------------------------------------------

/** Numeric log levels for structured logging (Database-Schema.md). */
export const LogLevel = {
  Trace: 0,
  Debug: 10,
  Info: 20,
  Warn: 30,
  Error: 40,
  Audit: 50,
} as const;

export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

// ---------------------------------------------------------------------------
// Model Tier
// ---------------------------------------------------------------------------

/** Model tier system — skills specify a tier, providers map to actual models. */
export const ModelTier = {
  Haiku: 'haiku',
  Sonnet: 'sonnet',
  Opus: 'opus',
} as const;

export type ModelTier = (typeof ModelTier)[keyof typeof ModelTier];

// ---------------------------------------------------------------------------
// Agent Role
// ---------------------------------------------------------------------------

/** Role of an agent within the hierarchy. */
export const AgentRole = {
  MainAssistant: 'main_assistant',
  TeamLead: 'team_lead',
  Member: 'member',
} as const;

export type AgentRole = (typeof AgentRole)[keyof typeof AgentRole];

// ---------------------------------------------------------------------------
// Agent Status
// ---------------------------------------------------------------------------

/** Runtime status of an agent, reported via heartbeat (WebSocket-Protocol.md). */
export const AgentStatus = {
  Idle: 'idle',
  Busy: 'busy',
  Error: 'error',
  Starting: 'starting',
} as const;

export type AgentStatus = (typeof AgentStatus)[keyof typeof AgentStatus];

// ---------------------------------------------------------------------------
// Container Health
// ---------------------------------------------------------------------------

/** Container lifecycle health states (Control-Plane.md state machine). */
export const ContainerHealth = {
  Starting: 'starting',
  Running: 'running',
  Degraded: 'degraded',
  Unhealthy: 'unhealthy',
  Unreachable: 'unreachable',
  Stopping: 'stopping',
  Stopped: 'stopped',
} as const;

export type ContainerHealth = (typeof ContainerHealth)[keyof typeof ContainerHealth];

// ---------------------------------------------------------------------------
// Channel Type
// ---------------------------------------------------------------------------

/** Messaging channel adapters (Database-Schema.md chat_sessions.channel_type). */
export const ChannelType = {
  Discord: 'discord',
  Slack: 'slack',
  WhatsApp: 'whatsapp',
  Api: 'api',
  Cli: 'cli',
} as const;

export type ChannelType = (typeof ChannelType)[keyof typeof ChannelType];

// ---------------------------------------------------------------------------
// Tool Timeout Tier
// ---------------------------------------------------------------------------

/** Timeout tiers for built-in tools (MCP-Tools.md). */
export const ToolTimeoutTier = {
  Query: 'query',
  Mutating: 'mutating',
  Blocking: 'blocking',
} as const;

export type ToolTimeoutTier = (typeof ToolTimeoutTier)[keyof typeof ToolTimeoutTier];

/** Default timeout values in milliseconds for each tier. */
export const ToolTimeoutMs = {
  [ToolTimeoutTier.Query]: 10_000,
  [ToolTimeoutTier.Mutating]: 60_000,
  [ToolTimeoutTier.Blocking]: 300_000,
} as const;

// ---------------------------------------------------------------------------
// Provider Type
// ---------------------------------------------------------------------------

/** AI provider authentication type (Configuration-Schemas.md). */
export const ProviderType = {
  OAuth: 'oauth',
  AnthropicDirect: 'anthropic_direct',
} as const;

export type ProviderType = (typeof ProviderType)[keyof typeof ProviderType];

// ---------------------------------------------------------------------------
// Memory Type
// ---------------------------------------------------------------------------

/** Agent memory entry type (Database-Schema.md agent_memories.memory_type). */
export const MemoryType = {
  Curated: 'curated',
  Daily: 'daily',
} as const;

export type MemoryType = (typeof MemoryType)[keyof typeof MemoryType];

// ---------------------------------------------------------------------------
// Decision Type
// ---------------------------------------------------------------------------

/** LLM decision types logged to the decisions table (Database-Schema.md). */
export const DecisionType = {
  Routing: 'routing',
  Escalation: 'escalation',
  Delegation: 'delegation',
  Prioritization: 'prioritization',
} as const;

export type DecisionType = (typeof DecisionType)[keyof typeof DecisionType];

// ---------------------------------------------------------------------------
// Escalation Reason
// ---------------------------------------------------------------------------

/** Reason for escalation (WebSocket-Protocol.md escalation message). */
export const EscalationReason = {
  NeedGuidance: 'need_guidance',
  OutOfScope: 'out_of_scope',
  Error: 'error',
  Timeout: 'timeout',
} as const;

export type EscalationReason = (typeof EscalationReason)[keyof typeof EscalationReason];

// ---------------------------------------------------------------------------
// Integration Status
// ---------------------------------------------------------------------------

/** Integration lifecycle states (Database-Schema.md integrations.status). */
export const IntegrationStatus = {
  Proposed: 'proposed',
  Validated: 'validated',
  Tested: 'tested',
  Approved: 'approved',
  Active: 'active',
  Failed: 'failed',
  RolledBack: 'rolled_back',
} as const;

export type IntegrationStatus = (typeof IntegrationStatus)[keyof typeof IntegrationStatus];

// ---------------------------------------------------------------------------
// WebSocket Error Code
// ---------------------------------------------------------------------------

/** Error codes returned in tool_result on failure (WebSocket-Protocol.md). */
export const WSErrorCode = {
  NotFound: 'NOT_FOUND',
  ValidationError: 'VALIDATION_ERROR',
  Conflict: 'CONFLICT',
  EncryptionLocked: 'ENCRYPTION_LOCKED',
  RateLimited: 'RATE_LIMITED',
  AccessDenied: 'ACCESS_DENIED',
  InternalError: 'INTERNAL_ERROR',
  DepthLimitExceeded: 'DEPTH_LIMIT_EXCEEDED',
  CycleDetected: 'CYCLE_DETECTED',
} as const;

export type WSErrorCode = (typeof WSErrorCode)[keyof typeof WSErrorCode];

// ---------------------------------------------------------------------------
// Message Direction
// ---------------------------------------------------------------------------

/** WebSocket message flow direction (WebSocket-Protocol.md). */
export const MessageDirection = {
  RootToContainer: 'root_to_container',
  ContainerToRoot: 'container_to_root',
} as const;

export type MessageDirection = (typeof MessageDirection)[keyof typeof MessageDirection];
