/**
 * Core interfaces for OpenHive v3.
 *
 * Every external dependency sits behind an interface defined here.
 */

import type {
  TeamConfig,
  TriggerConfig,
  LogEntry,
  OrgTreeNode,
  TaskEntry,
  TaskStatus,
  EscalationCorrelation,
} from './types.js';

// ── Session ────────────────────────────────────────────────────────────────

export interface ISessionSpawner {
  spawn(teamId: string, agentId: string): Promise<string>;
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
}

// ── Stores ─────────────────────────────────────────────────────────────────

export interface IOrgStore {
  addTeam(node: OrgTreeNode): void;
  removeTeam(id: string): void;
  getTeam(id: string): OrgTreeNode | undefined;
  getChildren(parentId: string): OrgTreeNode[];
  getAncestors(id: string): OrgTreeNode[];
  getAll(): OrgTreeNode[];
}

export interface ITaskQueueStore {
  enqueue(teamId: string, task: string, priority: string, correlationId?: string): string;
  dequeue(teamId: string): TaskEntry | undefined;
  peek(teamId: string): TaskEntry | undefined;
  getByTeam(teamId: string): TaskEntry[];
  updateStatus(taskId: string, status: TaskStatus): void;
  getPending(): TaskEntry[];
  getByStatus(status: TaskStatus): TaskEntry[];
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
  updateStatus(correlationId: string, status: string): void;
  getByCorrelationId(id: string): EscalationCorrelation | undefined;
}

export interface IMemoryStore {
  readFile(teamName: string, filename: string): string | undefined;
  writeFile(teamName: string, filename: string, content: string): void;
  listFiles(teamName: string): string[];
}

// ── Config (used by L1+ layers) ────────────────────────────────────────────

export type { TeamConfig, TriggerConfig };
