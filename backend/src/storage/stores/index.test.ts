/**
 * Tests for all 10 store implementations + Transactor.
 *
 * Uses real in-memory SQLite via newInMemoryDB() — no mocks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database, newInMemoryDB } from '../database.js';
import {
  newTaskStore,
  newMessageStore,
  newLogStore,
  newTaskEventStore,
  newToolCallStore,
  newDecisionStore,
  newSessionStore,
  newMemoryStore,
  newIntegrationStore,
  newCredentialStore,
  newTransactor,
} from './index.js';
import type { Task, Message, LogEntry, ChatSession, MemoryEntry, Integration, Credential, TaskEvent, ToolCall, Decision } from '../../domain/domain.js';
import { TaskStatus, LogLevel, IntegrationStatus } from '../../domain/enums.js';
import { NotFoundError, CycleDetectedError, InvalidTransitionError } from '../../domain/errors.js';
import * as schema from '../schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const now = Date.now();

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    parent_id: '',
    team_slug: 'team-alpha',
    agent_aid: 'aid-test-abc123',
    title: 'Test task',
    status: TaskStatus.Pending,
    prompt: 'Do something',
    result: '',
    error: '',
    blocked_by: null,
    priority: 0,
    retry_count: 0,
    max_retries: 3,
    created_at: now,
    updated_at: now,
    completed_at: null,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    chat_jid: 'chat-1',
    role: 'user',
    content: 'Hello',
    type: 'text',
    timestamp: now,
    ...overrides,
  };
}

function makeLogEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    id: 0, // auto-increment
    level: LogLevel.Info,
    event_type: 'test',
    component: 'test-component',
    action: 'test-action',
    message: 'Test log entry',
    params: '',
    team_slug: 'team-alpha',
    task_id: '',
    agent_aid: '',
    request_id: '',
    correlation_id: '',
    error: '',
    duration_ms: 0,
    created_at: now,
    ...overrides,
  };
}

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    chat_jid: 'chat-1',
    channel_type: 'discord' as ChatSession['channel_type'],
    last_timestamp: now,
    last_agent_timestamp: now,
    session_id: 'sess-1',
    agent_aid: 'aid-test-abc123',
    tid: 'tid-team-abc1',
    ...overrides,
  };
}

function makeMemory(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 0, // auto-increment
    agent_aid: 'aid-test-abc123',
    team_slug: 'team-alpha',
    content: 'Remember this fact',
    memory_type: 'curated' as MemoryEntry['memory_type'],
    created_at: now,
    deleted_at: null,
    ...overrides,
  };
}

function makeIntegration(overrides: Partial<Integration> = {}): Integration {
  return {
    id: 'int-1',
    team_id: 'tid-alpha-abc123',
    name: 'test-integration',
    config_path: '/path/to/config.yaml',
    status: IntegrationStatus.Proposed,
    error_message: '',
    created_at: now,
    ...overrides,
  };
}

function makeCredential(overrides: Partial<Credential> = {}): Credential {
  return {
    id: 'cred-1',
    name: 'api-key',
    encrypted_value: 'encrypted-data-here',
    team_id: 'tid-alpha-abc123',
    created_at: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('TaskStore', () => {
  let db: Database;
  let store: ReturnType<typeof newTaskStore>;

  beforeEach(async () => {
    db = newInMemoryDB();
    await db.initialize();
    store = newTaskStore(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('creates and retrieves a task', async () => {
    const task = makeTask();
    await store.create(task);
    const retrieved = await store.get('task-1');
    expect(retrieved.id).toBe('task-1');
    expect(retrieved.title).toBe('Test task');
    expect(retrieved.status).toBe(TaskStatus.Pending);
  });

  it('throws NotFoundError for missing task', async () => {
    await expect(store.get('nonexistent')).rejects.toThrow(NotFoundError);
  });

  it('updates a task with valid transition', async () => {
    await store.create(makeTask());
    const task = await store.get('task-1');
    task.status = TaskStatus.Active;
    task.updated_at = Date.now();
    await store.update(task);
    const updated = await store.get('task-1');
    expect(updated.status).toBe(TaskStatus.Active);
  });

  it('rejects invalid state transition', async () => {
    await store.create(makeTask({ status: TaskStatus.Completed }));
    const task = await store.get('task-1');
    task.status = TaskStatus.Active;
    await expect(store.update(task)).rejects.toThrow(/Invalid task state transition/);
  });

  it('deletes a task', async () => {
    await store.create(makeTask());
    await store.delete('task-1');
    await expect(store.get('task-1')).rejects.toThrow(NotFoundError);
  });

  it('lists tasks by team', async () => {
    await store.create(makeTask({ id: 't1', team_slug: 'team-alpha' }));
    await store.create(makeTask({ id: 't2', team_slug: 'team-alpha' }));
    await store.create(makeTask({ id: 't3', team_slug: 'team-beta' }));
    const results = await store.listByTeam('team-alpha');
    expect(results).toHaveLength(2);
  });

  it('lists tasks by status', async () => {
    await store.create(makeTask({ id: 't1', status: TaskStatus.Pending }));
    await store.create(makeTask({ id: 't2', status: TaskStatus.Active }));
    await store.create(makeTask({ id: 't3', status: TaskStatus.Pending }));
    const results = await store.listByStatus(TaskStatus.Pending);
    expect(results).toHaveLength(2);
  });

  it('gets subtree recursively', async () => {
    await store.create(makeTask({ id: 'root', parent_id: '' }));
    await store.create(makeTask({ id: 'child1', parent_id: 'root' }));
    await store.create(makeTask({ id: 'child2', parent_id: 'root' }));
    await store.create(makeTask({ id: 'grandchild', parent_id: 'child1' }));
    const subtree = await store.getSubtree('root');
    expect(subtree).toHaveLength(4);
    const ids = subtree.map(t => t.id).sort();
    expect(ids).toEqual(['child1', 'child2', 'grandchild', 'root']);
  });

  it('detects dependency cycles (A->B->C->A)', async () => {
    // Create A, B, C with no deps
    await store.create(makeTask({ id: 'A' }));
    await store.create(makeTask({ id: 'B', blocked_by: ['A'] }));
    await store.create(makeTask({ id: 'C', blocked_by: ['B'] }));

    // Now try to make A blocked by C — creates a cycle
    await expect(
      store.validateDependencies('A', ['C'])
    ).rejects.toThrow(CycleDetectedError);
  });

  it('validates dependencies — missing task throws NotFoundError', async () => {
    await store.create(makeTask({ id: 'A' }));
    await expect(
      store.validateDependencies('A', ['nonexistent'])
    ).rejects.toThrow(NotFoundError);
  });

  it('getBlockedBy returns parsed dependency list', async () => {
    await store.create(makeTask({ id: 'A' }));
    await store.create(makeTask({ id: 'B' }));
    await store.create(makeTask({ id: 'C', blocked_by: ['A', 'B'] }));
    const blockers = await store.getBlockedBy('C');
    expect(blockers).toEqual(['A', 'B']);
  });

  it('unblockTask removes a completed dependency', async () => {
    await store.create(makeTask({ id: 'A' }));
    await store.create(makeTask({ id: 'B' }));
    await store.create(makeTask({ id: 'C', blocked_by: ['A', 'B'] }));

    const unblocked = await store.unblockTask('C', 'A');
    expect(unblocked).toBe(false); // Still blocked by B

    const unblocked2 = await store.unblockTask('C', 'B');
    expect(unblocked2).toBe(true); // Now fully unblocked

    const blockers = await store.getBlockedBy('C');
    expect(blockers).toEqual([]);
  });

  it('unblockTask returns false for non-existent dependency', async () => {
    await store.create(makeTask({ id: 'X' }));
    await store.create(makeTask({ id: 'A', blocked_by: ['X'] }));
    const result = await store.unblockTask('A', 'nonexistent');
    expect(result).toBe(false);
  });

  it('retryTask increments count and transitions to pending', async () => {
    await store.create(makeTask({ id: 'A', status: TaskStatus.Failed, retry_count: 0, max_retries: 3 }));
    const retried = await store.retryTask('A');
    expect(retried).toBe(true);
    const task = await store.get('A');
    expect(task.status).toBe(TaskStatus.Pending);
    expect(task.retry_count).toBe(1);
  });

  it('retryTask returns false when max retries reached', async () => {
    await store.create(makeTask({ id: 'A', status: TaskStatus.Failed, retry_count: 3, max_retries: 3 }));
    const retried = await store.retryTask('A');
    expect(retried).toBe(false);
  });
});

describe('MessageStore', () => {
  let db: Database;
  let store: ReturnType<typeof newMessageStore>;

  beforeEach(async () => {
    db = newInMemoryDB();
    await db.initialize();
    store = newMessageStore(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('creates and retrieves messages by chat', async () => {
    await store.create(makeMessage({ id: 'm1', timestamp: 1000 }));
    await store.create(makeMessage({ id: 'm2', timestamp: 2000 }));
    const results = await store.getByChat('chat-1', new Date(0), 10);
    expect(results).toHaveLength(2);
  });

  it('paginates with since + limit', async () => {
    await store.create(makeMessage({ id: 'm1', timestamp: 1000 }));
    await store.create(makeMessage({ id: 'm2', timestamp: 2000 }));
    await store.create(makeMessage({ id: 'm3', timestamp: 3000 }));

    const results = await store.getByChat('chat-1', new Date(1500), 10);
    expect(results).toHaveLength(2); // m2 and m3

    const limited = await store.getByChat('chat-1', new Date(0), 2);
    expect(limited).toHaveLength(2);
  });

  it('getLatest returns N most recent in chronological order', async () => {
    await store.create(makeMessage({ id: 'm1', timestamp: 1000 }));
    await store.create(makeMessage({ id: 'm2', timestamp: 2000 }));
    await store.create(makeMessage({ id: 'm3', timestamp: 3000 }));
    const latest = await store.getLatest('chat-1', 2);
    expect(latest).toHaveLength(2);
    expect(latest[0].id).toBe('m2');
    expect(latest[1].id).toBe('m3');
  });

  it('deleteByChat removes all messages for a chat', async () => {
    await store.create(makeMessage({ id: 'm1', chat_jid: 'chat-1' }));
    await store.create(makeMessage({ id: 'm2', chat_jid: 'chat-2' }));
    await store.deleteByChat('chat-1');
    const results = await store.getByChat('chat-1', new Date(0), 10);
    expect(results).toHaveLength(0);
    const remaining = await store.getByChat('chat-2', new Date(0), 10);
    expect(remaining).toHaveLength(1);
  });

  it('deleteBefore removes old messages and returns count', async () => {
    await store.create(makeMessage({ id: 'm1', timestamp: 1000 }));
    await store.create(makeMessage({ id: 'm2', timestamp: 2000 }));
    await store.create(makeMessage({ id: 'm3', timestamp: 3000 }));
    const deleted = await store.deleteBefore(new Date(2500));
    expect(deleted).toBe(2);
    const results = await store.getByChat('chat-1', new Date(0), 10);
    expect(results).toHaveLength(1);
  });
});

describe('LogStore', () => {
  let db: Database;
  let store: ReturnType<typeof newLogStore>;

  beforeEach(async () => {
    db = newInMemoryDB();
    await db.initialize();
    store = newLogStore(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('batch inserts multiple entries', async () => {
    const entries = [
      makeLogEntry({ created_at: 1000, message: 'Entry 1' }),
      makeLogEntry({ created_at: 2000, message: 'Entry 2' }),
      makeLogEntry({ created_at: 3000, message: 'Entry 3' }),
    ];
    await store.create(entries);
    const count = await store.count();
    expect(count).toBe(3);
  });

  it('create with empty array is a no-op', async () => {
    await store.create([]);
    const count = await store.count();
    expect(count).toBe(0);
  });

  it('queries with level filter', async () => {
    await store.create([
      makeLogEntry({ level: LogLevel.Debug, created_at: 1000 }),
      makeLogEntry({ level: LogLevel.Info, created_at: 2000 }),
      makeLogEntry({ level: LogLevel.Error, created_at: 3000 }),
    ]);
    const results = await store.query({ level: LogLevel.Info });
    // level filter uses >= so Info (20) and Error (40) match
    expect(results).toHaveLength(2);
  });

  it('queries with component filter', async () => {
    await store.create([
      makeLogEntry({ component: 'orchestrator', created_at: 1000 }),
      makeLogEntry({ component: 'executor', created_at: 2000 }),
    ]);
    const results = await store.query({ component: 'orchestrator' });
    expect(results).toHaveLength(1);
    expect(results[0].component).toBe('orchestrator');
  });

  it('queries with time range', async () => {
    await store.create([
      makeLogEntry({ created_at: 1000 }),
      makeLogEntry({ created_at: 2000 }),
      makeLogEntry({ created_at: 3000 }),
    ]);
    const results = await store.query({
      since: new Date(1500),
      until: new Date(2500),
    });
    expect(results).toHaveLength(1);
  });

  it('deleteBefore removes old entries', async () => {
    await store.create([
      makeLogEntry({ created_at: 1000 }),
      makeLogEntry({ created_at: 2000 }),
      makeLogEntry({ created_at: 3000 }),
    ]);
    const deleted = await store.deleteBefore(new Date(2500));
    expect(deleted).toBe(2);
    const count = await store.count();
    expect(count).toBe(1);
  });

  it('deleteByLevelBefore removes entries by level + time (retention tiers)', async () => {
    await store.create([
      makeLogEntry({ level: LogLevel.Debug, created_at: 1000 }),
      makeLogEntry({ level: LogLevel.Info, created_at: 1000 }),
      makeLogEntry({ level: LogLevel.Error, created_at: 1000 }),
      makeLogEntry({ level: LogLevel.Debug, created_at: 5000 }),
    ]);
    // Delete debug and lower before ts 2000
    const deleted = await store.deleteByLevelBefore(LogLevel.Debug, new Date(2000));
    expect(deleted).toBe(1); // Only the Debug at 1000
    const count = await store.count();
    expect(count).toBe(3);
  });

  it('getOldest returns entries in ascending order', async () => {
    await store.create([
      makeLogEntry({ created_at: 3000, message: 'Third' }),
      makeLogEntry({ created_at: 1000, message: 'First' }),
      makeLogEntry({ created_at: 2000, message: 'Second' }),
    ]);
    const oldest = await store.getOldest(2);
    expect(oldest).toHaveLength(2);
    expect(oldest[0].message).toBe('First');
    expect(oldest[1].message).toBe('Second');
  });
});

describe('TaskEventStore', () => {
  let db: Database;
  let logStore: ReturnType<typeof newLogStore>;
  let store: ReturnType<typeof newTaskEventStore>;

  beforeEach(async () => {
    db = newInMemoryDB();
    await db.initialize();
    logStore = newLogStore(db);
    store = newTaskEventStore(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('creates and retrieves task events by task', async () => {
    // Need a log entry first (FK constraint)
    await logStore.create([makeLogEntry({ created_at: now })]);
    const logEntries = await logStore.getOldest(1);
    const logEntryId = logEntries[0].id;

    const event: TaskEvent = {
      id: 0,
      log_entry_id: logEntryId,
      task_id: 'task-1',
      from_status: 'pending',
      to_status: 'active',
      agent_aid: 'aid-test-abc123',
      reason: 'Started work',
      created_at: now,
    };
    await store.create(event);

    const events = await store.getByTask('task-1');
    expect(events).toHaveLength(1);
    expect(events[0].to_status).toBe('active');
  });

  it('getByLogEntry returns matching event or null', async () => {
    await logStore.create([makeLogEntry({ created_at: now })]);
    const logEntries = await logStore.getOldest(1);
    const logEntryId = logEntries[0].id;

    const event: TaskEvent = {
      id: 0,
      log_entry_id: logEntryId,
      task_id: 'task-1',
      from_status: 'pending',
      to_status: 'active',
      agent_aid: '',
      reason: '',
      created_at: now,
    };
    await store.create(event);

    const found = await store.getByLogEntry(logEntryId);
    expect(found).not.toBeNull();
    expect(found!.task_id).toBe('task-1');

    const notFound = await store.getByLogEntry(99999);
    expect(notFound).toBeNull();
  });
});

describe('ToolCallStore', () => {
  let db: Database;
  let logStore: ReturnType<typeof newLogStore>;
  let store: ReturnType<typeof newToolCallStore>;

  beforeEach(async () => {
    db = newInMemoryDB();
    await db.initialize();
    logStore = newLogStore(db);
    store = newToolCallStore(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('creates and retrieves by task', async () => {
    await logStore.create([makeLogEntry({ created_at: now })]);
    const logEntries = await logStore.getOldest(1);

    const call: ToolCall = {
      id: 0,
      log_entry_id: logEntries[0].id,
      tool_use_id: 'tu-1',
      tool_name: 'create_team',
      agent_aid: 'aid-test-abc123',
      team_slug: 'team-alpha',
      task_id: 'task-1',
      params: '{}',
      result_summary: 'ok',
      error: '',
      duration_ms: 100,
      created_at: now,
    };
    await store.create(call);

    const results = await store.getByTask('task-1');
    expect(results).toHaveLength(1);
    expect(results[0].tool_name).toBe('create_team');
  });

  it('retrieves by agent with since filter', async () => {
    await logStore.create([
      makeLogEntry({ created_at: 1000 }),
      makeLogEntry({ created_at: 2000 }),
    ]);
    const entries = await logStore.getOldest(2);

    await store.create({
      id: 0, log_entry_id: entries[0].id, tool_use_id: 'tu-1',
      tool_name: 'create_team', agent_aid: 'aid-a-1', team_slug: '', task_id: '',
      params: '', result_summary: '', error: '', duration_ms: 0, created_at: 1000,
    });
    await store.create({
      id: 0, log_entry_id: entries[1].id, tool_use_id: 'tu-2',
      tool_name: 'send_message', agent_aid: 'aid-a-1', team_slug: '', task_id: '',
      params: '', result_summary: '', error: '', duration_ms: 0, created_at: 2000,
    });

    const results = await store.getByAgent('aid-a-1', new Date(1500));
    expect(results).toHaveLength(1);
    expect(results[0].tool_name).toBe('send_message');
  });

  it('retrieves by tool name with since filter', async () => {
    await logStore.create([makeLogEntry({ created_at: now })]);
    const entries = await logStore.getOldest(1);

    await store.create({
      id: 0, log_entry_id: entries[0].id, tool_use_id: 'tu-1',
      tool_name: 'escalate', agent_aid: 'aid-a-1', team_slug: '', task_id: '',
      params: '', result_summary: '', error: '', duration_ms: 0, created_at: now,
    });

    const results = await store.getByToolName('escalate', new Date(0));
    expect(results).toHaveLength(1);
  });
});

describe('DecisionStore', () => {
  let db: Database;
  let logStore: ReturnType<typeof newLogStore>;
  let store: ReturnType<typeof newDecisionStore>;

  beforeEach(async () => {
    db = newInMemoryDB();
    await db.initialize();
    logStore = newLogStore(db);
    store = newDecisionStore(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('creates and retrieves by task', async () => {
    await logStore.create([makeLogEntry({ created_at: now })]);
    const entries = await logStore.getOldest(1);

    const decision: Decision = {
      id: 0,
      log_entry_id: entries[0].id,
      decision_type: 'routing' as Decision['decision_type'],
      agent_aid: 'aid-test-abc123',
      task_id: 'task-1',
      chosen_action: 'delegate to team-beta',
      alternatives: 'handle locally',
      reasoning: 'Task matches team-beta skills',
      created_at: now,
    };
    await store.create(decision);

    const results = await store.getByTask('task-1');
    expect(results).toHaveLength(1);
    expect(results[0].chosen_action).toBe('delegate to team-beta');
  });

  it('retrieves by agent and by type', async () => {
    await logStore.create([
      makeLogEntry({ created_at: 1000 }),
      makeLogEntry({ created_at: 2000 }),
    ]);
    const entries = await logStore.getOldest(2);

    await store.create({
      id: 0, log_entry_id: entries[0].id, decision_type: 'routing' as Decision['decision_type'],
      agent_aid: 'aid-a-1', task_id: '', chosen_action: '', alternatives: '',
      reasoning: '', created_at: 1000,
    });
    await store.create({
      id: 0, log_entry_id: entries[1].id, decision_type: 'escalation' as Decision['decision_type'],
      agent_aid: 'aid-a-1', task_id: '', chosen_action: '', alternatives: '',
      reasoning: '', created_at: 2000,
    });

    const byAgent = await store.getByAgent('aid-a-1', new Date(0));
    expect(byAgent).toHaveLength(2);

    const byType = await store.getByType('routing', new Date(0));
    expect(byType).toHaveLength(1);
  });
});

describe('SessionStore', () => {
  let db: Database;
  let store: ReturnType<typeof newSessionStore>;

  beforeEach(async () => {
    db = newInMemoryDB();
    await db.initialize();
    store = newSessionStore(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('throws NotFoundError for missing session', async () => {
    await expect(store.get('nonexistent')).rejects.toThrow(NotFoundError);
  });

  it('upsert creates a new session', async () => {
    await store.upsert(makeSession());
    const session = await store.get('chat-1');
    expect(session.channel_type).toBe('discord');
  });

  it('upsert updates existing session', async () => {
    await store.upsert(makeSession());
    await store.upsert(makeSession({ last_timestamp: now + 5000 }));
    const session = await store.get('chat-1');
    expect(session.last_timestamp).toBe(now + 5000);
  });

  it('deletes a session', async () => {
    await store.upsert(makeSession());
    await store.delete('chat-1');
    await expect(store.get('chat-1')).rejects.toThrow(NotFoundError);
  });

  it('listAll returns all sessions', async () => {
    await store.upsert(makeSession({ chat_jid: 'c1' }));
    await store.upsert(makeSession({ chat_jid: 'c2' }));
    const all = await store.listAll();
    expect(all).toHaveLength(2);
  });
});

describe('MemoryStore', () => {
  let db: Database;
  let store: ReturnType<typeof newMemoryStore>;

  beforeEach(async () => {
    db = newInMemoryDB();
    await db.initialize();
    store = newMemoryStore(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('save -> search -> soft delete -> purge round-trip', async () => {
    // Save
    await store.save(makeMemory({ content: 'The sky is blue' }));
    await store.save(makeMemory({ content: 'Water is wet', agent_aid: 'aid-other-def456' }));

    // Search by text
    const results = await store.search({ query: 'sky' });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('The sky is blue');

    // Search by agent
    const agentResults = await store.getByAgent('aid-test-abc123');
    expect(agentResults).toHaveLength(1);

    // Soft delete by agent
    const softDeleted = await store.softDeleteByAgent('aid-test-abc123');
    expect(softDeleted).toBe(1);

    // Verify soft-deleted entries are excluded from search
    const afterDelete = await store.search({ query: 'sky' });
    expect(afterDelete).toHaveLength(0);

    // purgeDeleted(0) cutoff = Date.now(), but deleted_at ~= Date.now() too,
    // so lt check won't match. Backdate deleted_at to ensure the purge works.
    const conn = db.getConnection();
    conn.prepare('UPDATE agent_memories SET deleted_at = 1000 WHERE deleted_at IS NOT NULL').run();
    const purged = await store.purgeDeleted(0);
    expect(purged).toBe(1);
  });

  it('search filters by team slug', async () => {
    await store.save(makeMemory({ content: 'Team A info', team_slug: 'team-alpha' }));
    await store.save(makeMemory({ content: 'Team B info', team_slug: 'team-beta' }));
    const results = await store.search({ teamSlug: 'team-alpha' });
    expect(results).toHaveLength(1);
  });

  it('softDeleteByTeam marks team memories as deleted', async () => {
    await store.save(makeMemory({ content: 'Mem 1', team_slug: 'team-alpha' }));
    await store.save(makeMemory({ content: 'Mem 2', team_slug: 'team-alpha' }));
    await store.save(makeMemory({ content: 'Mem 3', team_slug: 'team-beta' }));

    const count = await store.softDeleteByTeam('team-alpha');
    expect(count).toBe(2);

    const remaining = await store.search({});
    expect(remaining).toHaveLength(1);
    expect(remaining[0].content).toBe('Mem 3');
  });

  it('deleteBefore hard-deletes old entries', async () => {
    await store.save(makeMemory({ created_at: 1000 }));
    await store.save(makeMemory({ created_at: 5000 }));
    const deleted = await store.deleteBefore(new Date(3000));
    expect(deleted).toBe(1);
  });
});

describe('IntegrationStore', () => {
  let db: Database;
  let store: ReturnType<typeof newIntegrationStore>;

  beforeEach(async () => {
    db = newInMemoryDB();
    await db.initialize();
    store = newIntegrationStore(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('creates and retrieves an integration', async () => {
    await store.create(makeIntegration());
    const result = await store.get('int-1');
    expect(result.name).toBe('test-integration');
    expect(result.status).toBe(IntegrationStatus.Proposed);
  });

  it('throws NotFoundError for missing integration', async () => {
    await expect(store.get('nonexistent')).rejects.toThrow(NotFoundError);
  });

  it('updates an integration', async () => {
    await store.create(makeIntegration());
    const updated = { ...makeIntegration(), name: 'renamed' };
    await store.update(updated);
    const result = await store.get('int-1');
    expect(result.name).toBe('renamed');
  });

  it('deletes an integration', async () => {
    await store.create(makeIntegration());
    await store.delete('int-1');
    await expect(store.get('int-1')).rejects.toThrow(NotFoundError);
  });

  it('lists by team', async () => {
    await store.create(makeIntegration({ id: 'i1', team_id: 'tid-alpha-abc123' }));
    await store.create(makeIntegration({ id: 'i2', team_id: 'tid-alpha-abc123' }));
    await store.create(makeIntegration({ id: 'i3', team_id: 'tid-beta-def456' }));
    const results = await store.listByTeam('tid-alpha-abc123');
    expect(results).toHaveLength(2);
  });

  it('valid lifecycle transitions succeed', async () => {
    await store.create(makeIntegration());

    await store.updateStatus('int-1', IntegrationStatus.Validated);
    expect((await store.get('int-1')).status).toBe(IntegrationStatus.Validated);

    await store.updateStatus('int-1', IntegrationStatus.Tested);
    expect((await store.get('int-1')).status).toBe(IntegrationStatus.Tested);

    await store.updateStatus('int-1', IntegrationStatus.Approved);
    expect((await store.get('int-1')).status).toBe(IntegrationStatus.Approved);

    await store.updateStatus('int-1', IntegrationStatus.Active);
    expect((await store.get('int-1')).status).toBe(IntegrationStatus.Active);

    await store.updateStatus('int-1', IntegrationStatus.Failed);
    expect((await store.get('int-1')).status).toBe(IntegrationStatus.Failed);
  });

  it('invalid transition throws InvalidTransitionError', async () => {
    await store.create(makeIntegration());
    // proposed -> active is not valid (must go through validated, tested, approved)
    await expect(
      store.updateStatus('int-1', IntegrationStatus.Active)
    ).rejects.toThrow(InvalidTransitionError);
  });

  it('active -> rolled_back is valid', async () => {
    await store.create(makeIntegration({ status: IntegrationStatus.Active }));
    await store.updateStatus('int-1', IntegrationStatus.RolledBack);
    expect((await store.get('int-1')).status).toBe(IntegrationStatus.RolledBack);
  });
});

describe('CredentialStore', () => {
  let db: Database;
  let store: ReturnType<typeof newCredentialStore>;

  beforeEach(async () => {
    db = newInMemoryDB();
    await db.initialize();
    store = newCredentialStore(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('creates and retrieves a credential', async () => {
    await store.create(makeCredential());
    const result = await store.get('cred-1');
    expect(result.name).toBe('api-key');
    expect(result.encrypted_value).toBe('encrypted-data-here');
  });

  it('throws NotFoundError for missing credential', async () => {
    await expect(store.get('nonexistent')).rejects.toThrow(NotFoundError);
  });

  it('updates a credential', async () => {
    await store.create(makeCredential());
    await store.update({ ...makeCredential(), encrypted_value: 'new-encrypted-value' });
    const result = await store.get('cred-1');
    expect(result.encrypted_value).toBe('new-encrypted-value');
  });

  it('deletes a credential', async () => {
    await store.create(makeCredential());
    await store.delete('cred-1');
    await expect(store.get('cred-1')).rejects.toThrow(NotFoundError);
  });

  it('lists credentials by team (team-scoped)', async () => {
    await store.create(makeCredential({ id: 'c1', team_id: 'tid-alpha-abc123' }));
    await store.create(makeCredential({ id: 'c2', team_id: 'tid-alpha-abc123' }));
    await store.create(makeCredential({ id: 'c3', team_id: 'tid-beta-def456' }));
    const results = await store.listByTeam('tid-alpha-abc123');
    expect(results).toHaveLength(2);
  });
});

describe('Transactor', () => {
  let db: Database;
  let transactor: ReturnType<typeof newTransactor>;
  let taskStore: ReturnType<typeof newTaskStore>;

  beforeEach(async () => {
    db = newInMemoryDB();
    await db.initialize();
    transactor = newTransactor(db);
    taskStore = newTaskStore(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('commits a successful multi-step transaction', async () => {
    const result = await transactor.withTransaction(() => {
      db.getDB().insert(schema.tasks).values({
        id: 'tx-1', parent_id: '', team_slug: 'team-alpha', agent_aid: '',
        title: 'TX Task 1', status: 'pending', prompt: '', result: '', error: '',
        blocked_by: null, priority: 0, retry_count: 0, max_retries: 0,
        created_at: now, updated_at: now, completed_at: null,
      }).run();
      db.getDB().insert(schema.tasks).values({
        id: 'tx-2', parent_id: '', team_slug: 'team-alpha', agent_aid: '',
        title: 'TX Task 2', status: 'pending', prompt: '', result: '', error: '',
        blocked_by: null, priority: 0, retry_count: 0, max_retries: 0,
        created_at: now, updated_at: now, completed_at: null,
      }).run();
      return 'committed';
    });

    expect(result).toBe('committed');
    const t1 = await taskStore.get('tx-1');
    const t2 = await taskStore.get('tx-2');
    expect(t1.title).toBe('TX Task 1');
    expect(t2.title).toBe('TX Task 2');
  });

  it('rolls back on error — no partial writes', async () => {
    await expect(
      transactor.withTransaction(() => {
        db.getDB().insert(schema.tasks).values({
          id: 'tx-rollback', parent_id: '', team_slug: 'team-alpha', agent_aid: '',
          title: 'Should not persist', status: 'pending', prompt: '', result: '', error: '',
          blocked_by: null, priority: 0, retry_count: 0, max_retries: 0,
          created_at: now, updated_at: now, completed_at: null,
        }).run();
        throw new Error('Deliberate failure');
      })
    ).rejects.toThrow('Deliberate failure');

    // The task should NOT exist
    await expect(taskStore.get('tx-rollback')).rejects.toThrow(NotFoundError);
  });
});
