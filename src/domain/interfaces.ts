/**
 * Core interfaces for OpenHive v0.5.0.
 *
 * Every external dependency sits behind an interface defined here.
 */

import type {
  TeamConfig,
  TriggerConfig,
  TriggerState,
  LogEntry,
  OrgTreeNode,
  TaskEntry,
  TaskStatus,
  TaskType,
  TaskPriority,
  TaskOptions,
  TopicEntry,
  TopicState,
  EscalationCorrelation,
  MemoryEntry,
  MemorySearchResult,
  VaultEntry,
} from './types.js';

// ── Session ────────────────────────────────────────────────────────────────

export interface ISessionSpawner {
  spawn(teamId: string, agentId: string): Promise<string>;
  stop?(teamId: string): void;
}

export interface ISessionManager {
  getSession(sessionId: string): Promise<unknown>;
  terminateSession(sessionId: string): Promise<void>;
}

// ── Channel ────────────────────────────────────────────────────────────────

export interface IChannelAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void;
  sendResponse(channelId: string, content: string): Promise<void>;
}

export interface ChannelMessage {
  readonly channelId: string;
  readonly userId: string;
  readonly content: string;
  readonly timestamp: number;
  readonly topicHint?: string;
}

// ── Stores ─────────────────────────────────────────────────────────────────

export interface IOrgStore {
  addTeam(node: OrgTreeNode): void;
  removeTeam(id: string): void;
  getTeam(id: string): OrgTreeNode | undefined;
  getChildren(parentId: string): OrgTreeNode[];
  getAncestors(id: string): OrgTreeNode[];
  getAll(): OrgTreeNode[];
  addScopeKeywords(teamId: string, keywords: string[]): void;
  removeScopeKeywords(teamId: string): void;
  removeScopeKeyword(teamId: string, keyword: string): void;
  getOwnScope(teamId: string): string[];
  getEffectiveScope(teamId: string): string[];
  setBootstrapped(teamId: string): void;
  isBootstrapped(teamId: string): boolean;
}

export interface ITaskQueueStore {
  enqueue(teamId: string, task: string, priority: TaskPriority, type: TaskType, sourceChannelId?: string, correlationId?: string, options?: TaskOptions, topicId?: string): string;
  dequeue(teamId: string): TaskEntry | undefined;
  peek(teamId: string): TaskEntry | undefined;
  getActiveForTeam(teamId: string): TaskEntry[];
  getByTeam(teamId: string): TaskEntry[];
  updateStatus(taskId: string, status: TaskStatus): void;
  updateResult(taskId: string, result: string): void;
  updateDuration?(taskId: string, durationMs: number): void;
  getPending(): TaskEntry[];
  getByStatus(status: TaskStatus): TaskEntry[];
  removeByTeam(teamId: string): void;
  getById(taskId: string): TaskEntry | undefined;
}

export interface ITriggerStore {
  checkDedup(eventId: string, source: string): boolean;
  recordEvent(eventId: string, source: string, ttlSeconds: number): void;
  cleanExpired(): number;
}

export interface ILogStore {
  append(entry: LogEntry): void;
  query(opts: LogFilter): LogEntry[];
}

export interface LogFilter {
  readonly level?: LogEntry['level'];
  readonly since?: number;
  readonly limit?: number;
}

export interface IEscalationStore {
  create(correlation: EscalationCorrelation): void;
  getByCorrelationId(id: string): EscalationCorrelation | undefined;
  removeByTeam(teamId: string): void;
}

export interface IMemoryStore {
  save(teamName: string, key: string, content: string, type: string, supersedeReason?: string, updatedBy?: string): MemoryEntry;
  delete(teamName: string, key: string): boolean;
  search(teamName: string, query: string, maxResults?: number, embeddingFn?: (text: string) => Promise<number[]>): Promise<MemorySearchResult[]>;
  list(teamName: string, type?: string): MemoryEntry[];
  getActive(teamName: string, key: string): MemoryEntry | undefined;
  getInjectable(teamName: string, limit?: number): MemoryEntry[];
  removeByTeam(teamName: string): void;
}

// ── Trigger Config Store ──────────────────────────────────────────────────

export interface ITriggerConfigStore {
  upsert(config: TriggerConfig): void;
  remove(team: string, name: string): void;
  removeByTeam(team: string): void;
  getByTeam(team: string): TriggerConfig[];
  getAll(): TriggerConfig[];
  setState(team: string, name: string, state: TriggerState, reason?: string): void;
  incrementFailures(team: string, name: string): number;
  resetFailures(team: string, name: string): void;
  get(team: string, name: string): TriggerConfig | undefined;
  setActiveTask(team: string, name: string, taskId: string): void;
  clearActiveTask(team: string, name: string): void;
  setOverlapCount(team: string, name: string, count: number): void;
  resetOverlapState(team: string, name: string): void;
}

// ── Plugin Tool Store ───────────────────────────────────────────────────

export interface PluginToolMeta {
  readonly teamName: string;
  readonly toolName: string;
  readonly status: 'active' | 'deprecated' | 'failed_verification' | 'removed';
  readonly sourcePath: string;
  readonly sourceHash: string;
  readonly verification: PluginToolVerification;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly verifiedAt: string | null;
  readonly deprecatedAt?: string | null;
  readonly deprecatedReason?: string | null;
  readonly deprecatedBy?: string | null;
  readonly removedAt?: string | null;
  readonly removedBy?: string | null;
}

export interface PluginToolVerification {
  typescript?: { valid: boolean; errors: string[] };
  interface?: { hasDescription: boolean; hasParameters: boolean; hasExecute: boolean };
  security?: { forbiddenPatterns: string[]; detectedSecrets: string[]; passed: boolean };
}

export interface IPluginToolStore {
  upsert(meta: PluginToolMeta): void;
  get(teamName: string, toolName: string): PluginToolMeta | undefined;
  getByTeam(teamName: string): PluginToolMeta[];
  getAll(): PluginToolMeta[];
  setStatus(teamName: string, toolName: string, status: PluginToolMeta['status']): void;
  deprecate(teamName: string, toolName: string, reason: string, by: string): void;
  markRemoved(teamName: string, toolName: string, by: string): void;
  remove(teamName: string, toolName: string): void;
  removeByTeam(teamName: string): void;
}

// ── Interaction Store ─────────────────────────────────────────────────────

export interface InteractionRecord {
  readonly direction: 'inbound' | 'outbound';
  readonly channelType: string;
  readonly channelId: string;
  readonly userId?: string;
  readonly teamId?: string;
  readonly contentSnippet?: string;
  readonly contentLength?: number;
  readonly durationMs?: number;
  readonly topicId?: string;
  readonly trustDecision?: string;
  readonly createdAt?: string;
}

export interface IInteractionStore {
  log(record: InteractionRecord): void;
  getRecentByChannel(channelId: string, teamIds: string[], limit?: number, topicId?: string): InteractionRecord[];
  cleanOlderThan(cutoffIso: string): number;
  removeByTeam(teamId: string): void;
}

// ── Topic Store ──────────────────────────────────────────────────────────

export interface ITopicStore {
  create(topic: TopicEntry): void;
  getById(id: string): TopicEntry | undefined;
  getByChannel(channelId: string): TopicEntry[];
  getActiveByChannel(channelId: string): TopicEntry[];
  getIdleByChannel(channelId: string): TopicEntry[];
  updateState(topicId: string, state: TopicState): void;
  touchActivity(topicId: string): void;
  markAllIdle(channelId?: string): number;
}

// ── Sender Trust Store ──────────────────────────────────────────────────

export interface SenderTrustRecord {
  readonly channelType: string;
  readonly channelId?: string;
  readonly senderId: string;
  readonly trustLevel: string;
  readonly grantedBy: string;
  readonly createdAt: string;
}

export interface ISenderTrustStore {
  add(record: SenderTrustRecord): void;
  remove(channelType: string, senderId: string, channelId?: string): void;
  get(channelType: string, senderId: string, channelId?: string): SenderTrustRecord | undefined;
  list(channelType?: string, trustLevel?: string): SenderTrustRecord[];
}

// ── Trust Audit Store ───────────────────────────────────────────────────

export interface TrustAuditEntry {
  readonly channelType: string;
  readonly channelId: string;
  readonly senderId: string;
  readonly decision: string;
  readonly reason: string;
  readonly createdAt: string;
}

export interface ITrustAuditStore {
  log(entry: TrustAuditEntry): void;
  query(opts: { since?: string; decision?: string; senderId?: string; limit?: number }): TrustAuditEntry[];
}

// ── Vault Store ────────────────────────────────────────────────────────────

export interface IVaultStore {
  set(teamName: string, key: string, value: string, isSecret: boolean, updatedBy?: string): VaultEntry;
  get(teamName: string, key: string): VaultEntry | undefined;
  list(teamName: string): VaultEntry[];
  delete(teamName: string, key: string): boolean;
  getSecrets(teamName: string): VaultEntry[];
  removeByTeam(teamName: string): void;
}

// ── Config (used by L1+ layers) ────────────────────────────────────────────

export type { TeamConfig, TriggerConfig, TriggerState, TopicEntry, TopicState, VaultEntry };
