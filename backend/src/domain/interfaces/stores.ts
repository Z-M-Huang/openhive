/**
 * Store interfaces for database persistence.
 *
 * @module domain/interfaces/stores
 */

import type {
  Task,
  Message,
  LogEntry,
  ChatSession,
  TaskEvent,
  ToolCall,
  Decision,
  MemoryEntry,
  Integration,
  Credential,
} from '../domain.js';

import type {
  TaskStatus,
  IntegrationStatus,
} from '../enums.js';

import type { LogQueryOpts, MemoryQuery } from './supporting-types.js';

// ---------------------------------------------------------------------------
// Store Interfaces (Database-Schema.md)
// ---------------------------------------------------------------------------

/** Task persistence. Throws on database error. */
export interface TaskStore {
  create(task: Task): Promise<void>;
  get(id: string): Promise<Task>;
  update(task: Task): Promise<void>;
  delete(id: string): Promise<void>;
  listByTeam(teamSlug: string): Promise<Task[]>;
  listByStatus(status: TaskStatus): Promise<Task[]>;
  getSubtree(rootID: string): Promise<Task[]>;
  getBlockedBy(taskId: string): Promise<string[]>;
  unblockTask(taskId: string, completedDependencyId: string): Promise<boolean>;
  retryTask(taskId: string): Promise<boolean>;
  validateDependencies(taskId: string, blockedByIds: string[]): Promise<void>;
  /** Get recent user-originated root tasks for conversation history injection. */
  getRecentUserTasks(agentAid: string, limit: number): Promise<Task[]>;
  /** Get the oldest pending task assigned to this agent. Returns null if none. */
  getNextPendingForAgent(agentAid: string): Promise<Task | null>;
}

/** Chat message persistence. Throws on database error. */
export interface MessageStore {
  create(msg: Message): Promise<void>;
  getByChat(chatJID: string, since: Date, limit: number): Promise<Message[]>;
  getLatest(chatJID: string, n: number): Promise<Message[]>;
  deleteByChat(chatJID: string): Promise<void>;
  deleteBefore(before: Date): Promise<number>;
}

/** Structured log persistence. create() accepts an array for batch insert. */
export interface LogStore {
  create(entries: LogEntry[]): Promise<void>;
  /** Insert log entries and return their IDs. Non-breaking extension for FK relationships. */
  createWithIds(entries: LogEntry[]): Promise<number[]>;
  query(opts: LogQueryOpts): Promise<LogEntry[]>;
  deleteBefore(before: Date): Promise<number>;
  deleteByLevelBefore(level: number, before: Date): Promise<number>;
  count(): Promise<number>;
  getOldest(limit: number): Promise<LogEntry[]>;
}

/** Task lifecycle event persistence. */
export interface TaskEventStore {
  create(event: TaskEvent): Promise<void>;
  getByTask(taskId: string): Promise<TaskEvent[]>;
  getByLogEntry(logEntryId: number): Promise<TaskEvent | null>;
}

/** Tool invocation record persistence. */
export interface ToolCallStore {
  create(call: ToolCall): Promise<void>;
  getByTask(taskId: string): Promise<ToolCall[]>;
  getByAgent(agentAid: string, since: Date): Promise<ToolCall[]>;
  getByToolName(toolName: string, since: Date): Promise<ToolCall[]>;
}

/** LLM decision record persistence. */
export interface DecisionStore {
  create(decision: Decision): Promise<void>;
  getByTask(taskId: string): Promise<Decision[]>;
  getByAgent(agentAid: string, since: Date): Promise<Decision[]>;
  getByType(type: string, since: Date): Promise<Decision[]>;
}

/** Chat session persistence. get() throws NotFoundError when not found. */
export interface SessionStore {
  get(chatJID: string): Promise<ChatSession>;
  upsert(session: ChatSession): Promise<void>;
  delete(chatJID: string): Promise<void>;
  listAll(): Promise<ChatSession[]>;
}

/** Integration configuration persistence. */
export interface IntegrationStore {
  create(integration: Integration): Promise<void>;
  get(id: string): Promise<Integration>;
  update(integration: Integration): Promise<void>;
  delete(id: string): Promise<void>;
  listByTeam(teamId: string): Promise<Integration[]>;
  /** Update integration status. For terminal states (failed, rolled_back), pass errorMessage to record the cause (AC-G8). */
  updateStatus(id: string, status: IntegrationStatus, errorMessage?: string): Promise<void>;
}

/** Encrypted credential persistence (per-team). */
export interface CredentialStore {
  create(credential: Credential): Promise<void>;
  get(id: string): Promise<Credential>;
  update(credential: Credential): Promise<void>;
  delete(id: string): Promise<void>;
  listByTeam(teamId: string): Promise<Credential[]>;
}

/** Agent memory persistence with soft-delete and hybrid search. */
export interface MemoryStore {
  /** Save a memory entry. Returns the autoincrement id for chunk FK linkage. */
  save(entry: MemoryEntry): Promise<number>;
  search(query: MemoryQuery): Promise<MemoryEntry[]>;
  getByAgent(agentAID: string): Promise<MemoryEntry[]>;
  deleteBefore(date: Date): Promise<number>;
  softDeleteByAgent(agentAID: string): Promise<number>;
  softDeleteByTeam(teamSlug: string): Promise<number>;
  purgeDeleted(olderThanDays: number): Promise<number>;
  /** BM25 keyword search via FTS5. Falls back to LIKE if FTS5 unavailable. */
  searchBM25(query: string, agentAid: string, limit?: number): Promise<MemoryEntry[]>;
  /** Hybrid search: BM25 + vector with temporal decay and MMR. */
  searchHybrid(query: string, agentAid: string, queryEmbedding?: Float32Array, limit?: number): Promise<MemoryEntry[]>;
  /** Save embedding chunks for a memory entry. */
  saveChunks(memoryId: number, chunks: Array<{ content: string; embedding: Float32Array; embeddingModel: string }>): Promise<void>;
  /** Get embedding chunks for a memory entry. */
  getChunks(memoryId: number): Promise<MemoryChunk[]>;
  /** Delete chunks for a memory entry. */
  deleteChunks(memoryId: number): Promise<void>;
}

/** Embedding chunk stored alongside a memory entry. */
export interface MemoryChunk {
  id: number;
  memory_id: number;
  chunk_index: number;
  content: string;
  embedding: Float32Array;
  embedding_model: string;
  created_at: number;
}

/** Embedding service for vector search. */
export interface EmbeddingService {
  /** Compute embedding vector for text. */
  embed(text: string): Promise<Float32Array>;
  /** Model identifier for this service (stored per chunk for consistency). */
  readonly modelId: string;
}

/** Transaction wrapper. If the callback throws, the transaction rolls back. */
export type TxHandle = unknown;
export type TransactionCallback<T = void> = (tx: TxHandle) => T | Promise<T>;

export interface Transactor {
  withTransaction<T = void>(fn: TransactionCallback<T>): Promise<T>;
}
