/**
 * Store factory functions for all 8 database stores.
 *
 * Each factory accepts a Database instance and returns an object implementing
 * the corresponding store interface from domain/interfaces.ts. All methods
 * are stubs that throw until implemented in later layers.
 *
 * @module storage/stores
 */

import type { Database } from '../database.js';
import type {
  TaskStore,
  MessageStore,
  LogStore,
  LogQueryOpts,
  TaskEventStore,
  ToolCallStore,
  DecisionStore,
  SessionStore,
  MemoryStore,
  MemoryQuery,
} from '../../domain/interfaces.js';
import type {
  Task,
  Message,
  LogEntry,
  TaskEvent,
  ToolCall,
  Decision,
  ChatSession,
  MemoryEntry,
} from '../../domain/domain.js';
import type { TaskStatus } from '../../domain/enums.js';

/**
 * Creates a TaskStore backed by the given database.
 *
 * @param _db - Database instance (unused until implementation).
 * @returns TaskStore with all methods throwing 'Not implemented'.
 */
export function newTaskStore(_db: Database): TaskStore {
  return {
    async create(_task: Task): Promise<void> {
      throw new Error('Not implemented');
    },
    async get(_id: string): Promise<Task> {
      throw new Error('Not implemented');
    },
    async update(_task: Task): Promise<void> {
      throw new Error('Not implemented');
    },
    async delete(_id: string): Promise<void> {
      throw new Error('Not implemented');
    },
    async listByTeam(_teamSlug: string): Promise<Task[]> {
      throw new Error('Not implemented');
    },
    async listByStatus(_status: TaskStatus): Promise<Task[]> {
      throw new Error('Not implemented');
    },
    async getSubtree(_rootID: string): Promise<Task[]> {
      throw new Error('Not implemented');
    },
    async getBlockedBy(_taskId: string): Promise<string[]> {
      throw new Error('Not implemented');
    },
    async unblockTask(_taskId: string, _completedDependencyId: string): Promise<boolean> {
      throw new Error('Not implemented');
    },
    async retryTask(_taskId: string): Promise<boolean> {
      throw new Error('Not implemented');
    },
    async validateDependencies(_taskId: string, _blockedByIds: string[]): Promise<void> {
      throw new Error('Not implemented');
    },
  };
}

/**
 * Creates a MessageStore backed by the given database.
 *
 * @param _db - Database instance (unused until implementation).
 * @returns MessageStore with all methods throwing 'Not implemented'.
 */
export function newMessageStore(_db: Database): MessageStore {
  return {
    async create(_msg: Message): Promise<void> {
      throw new Error('Not implemented');
    },
    async getByChat(_chatJID: string, _since: Date, _limit: number): Promise<Message[]> {
      throw new Error('Not implemented');
    },
    async getLatest(_chatJID: string, _n: number): Promise<Message[]> {
      throw new Error('Not implemented');
    },
    async deleteByChat(_chatJID: string): Promise<void> {
      throw new Error('Not implemented');
    },
    async deleteBefore(_before: Date): Promise<number> {
      throw new Error('Not implemented');
    },
  };
}

/**
 * Creates a LogStore backed by the given database.
 *
 * @param _db - Database instance (unused until implementation).
 * @returns LogStore with all methods throwing 'Not implemented'.
 */
export function newLogStore(_db: Database): LogStore {
  return {
    async create(_entries: LogEntry[]): Promise<void> {
      throw new Error('Not implemented');
    },
    async query(_opts: LogQueryOpts): Promise<LogEntry[]> {
      throw new Error('Not implemented');
    },
    async deleteBefore(_before: Date): Promise<number> {
      throw new Error('Not implemented');
    },
    async deleteByLevelBefore(_level: number, _before: Date): Promise<number> {
      throw new Error('Not implemented');
    },
    async count(): Promise<number> {
      throw new Error('Not implemented');
    },
    async getOldest(_limit: number): Promise<LogEntry[]> {
      throw new Error('Not implemented');
    },
  };
}

/**
 * Creates a TaskEventStore backed by the given database.
 *
 * @param _db - Database instance (unused until implementation).
 * @returns TaskEventStore with all methods throwing 'Not implemented'.
 */
export function newTaskEventStore(_db: Database): TaskEventStore {
  return {
    async create(_event: TaskEvent): Promise<void> {
      throw new Error('Not implemented');
    },
    async getByTask(_taskId: string): Promise<TaskEvent[]> {
      throw new Error('Not implemented');
    },
    async getByLogEntry(_logEntryId: number): Promise<TaskEvent | null> {
      throw new Error('Not implemented');
    },
  };
}

/**
 * Creates a ToolCallStore backed by the given database.
 *
 * @param _db - Database instance (unused until implementation).
 * @returns ToolCallStore with all methods throwing 'Not implemented'.
 */
export function newToolCallStore(_db: Database): ToolCallStore {
  return {
    async create(_call: ToolCall): Promise<void> {
      throw new Error('Not implemented');
    },
    async getByTask(_taskId: string): Promise<ToolCall[]> {
      throw new Error('Not implemented');
    },
    async getByAgent(_agentAid: string, _since: Date): Promise<ToolCall[]> {
      throw new Error('Not implemented');
    },
    async getByToolName(_toolName: string, _since: Date): Promise<ToolCall[]> {
      throw new Error('Not implemented');
    },
  };
}

/**
 * Creates a DecisionStore backed by the given database.
 *
 * @param _db - Database instance (unused until implementation).
 * @returns DecisionStore with all methods throwing 'Not implemented'.
 */
export function newDecisionStore(_db: Database): DecisionStore {
  return {
    async create(_decision: Decision): Promise<void> {
      throw new Error('Not implemented');
    },
    async getByTask(_taskId: string): Promise<Decision[]> {
      throw new Error('Not implemented');
    },
    async getByAgent(_agentAid: string, _since: Date): Promise<Decision[]> {
      throw new Error('Not implemented');
    },
    async getByType(_type: string, _since: Date): Promise<Decision[]> {
      throw new Error('Not implemented');
    },
  };
}

/**
 * Creates a SessionStore backed by the given database.
 *
 * @param _db - Database instance (unused until implementation).
 * @returns SessionStore with all methods throwing 'Not implemented'.
 */
export function newSessionStore(_db: Database): SessionStore {
  return {
    async get(_chatJID: string): Promise<ChatSession> {
      throw new Error('Not implemented');
    },
    async upsert(_session: ChatSession): Promise<void> {
      throw new Error('Not implemented');
    },
    async delete(_chatJID: string): Promise<void> {
      throw new Error('Not implemented');
    },
    async listAll(): Promise<ChatSession[]> {
      throw new Error('Not implemented');
    },
  };
}

/**
 * Creates a MemoryStore backed by the given database.
 *
 * @param _db - Database instance (unused until implementation).
 * @returns MemoryStore with all methods throwing 'Not implemented'.
 */
export function newMemoryStore(_db: Database): MemoryStore {
  return {
    async save(_entry: MemoryEntry): Promise<void> {
      throw new Error('Not implemented');
    },
    async search(_query: MemoryQuery): Promise<MemoryEntry[]> {
      throw new Error('Not implemented');
    },
    async getByAgent(_agentAID: string): Promise<MemoryEntry[]> {
      throw new Error('Not implemented');
    },
    async deleteBefore(_date: Date): Promise<number> {
      throw new Error('Not implemented');
    },
    async softDeleteByAgent(_agentAID: string): Promise<number> {
      throw new Error('Not implemented');
    },
    async softDeleteByTeam(_teamSlug: string): Promise<number> {
      throw new Error('Not implemented');
    },
    async purgeDeleted(_olderThanDays: number): Promise<number> {
      throw new Error('Not implemented');
    },
  };
}
