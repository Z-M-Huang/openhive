/**
 * Tests for backend/src/store/schema.ts
 *
 * Verifies that all seven Drizzle ORM table definitions are correct:
 *   1. Table names are correct
 *   2. Column names match expected values
 *   3. Primary keys are set correctly
 *   4. Timestamps are stored as integers (Unix ms)
 *   5. All indexes are present with correct names
 *   6. log_entries.id is integer with autoIncrement
 *   7. completed_at is nullable
 *   8. New tables: escalations, agent_memories, triggers
 */

import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { getTableName } from 'drizzle-orm';
import {
  tasks,
  messages,
  log_entries,
  chat_sessions,
  escalations,
  agent_memories,
  triggers,
} from './schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts a map of column name → column object from getTableConfig.
 * This makes individual column assertions readable.
 */
function columnsByName(
  cfg: ReturnType<typeof getTableConfig>,
): Record<string, ReturnType<typeof getTableConfig>['columns'][number]> {
  return Object.fromEntries(cfg.columns.map((c) => [c.name, c]));
}

/**
 * Extracts the set of index names from getTableConfig.
 */
function indexNames(cfg: ReturnType<typeof getTableConfig>): Set<string> {
  return new Set(cfg.indexes.map((i) => i.config.name));
}

/**
 * Extracts index → columns mapping from getTableConfig.
 */
function indexColumns(
  cfg: ReturnType<typeof getTableConfig>,
): Record<string, string[]> {
  return Object.fromEntries(
    cfg.indexes.map((i) => [i.config.name, i.config.columns.map((c) => c.name)]),
  );
}

// ---------------------------------------------------------------------------
// tasks table
// ---------------------------------------------------------------------------

describe('tasks table', () => {
  const cfg = getTableConfig(tasks);
  const cols = columnsByName(cfg);
  const idxNames = indexNames(cfg);
  const idxCols = indexColumns(cfg);

  it('table name is "tasks" matching Go TableName()', () => {
    expect(cfg.name).toBe('tasks');
    expect(getTableName(tasks)).toBe('tasks');
  });

  it('has exactly 17 columns', () => {
    expect(cfg.columns).toHaveLength(17);
  });

  it('has all expected column names', () => {
    const expectedColumns = [
      'id',
      'parent_id',
      'team_slug',
      'agent_aid',
      'jid',
      'status',
      'prompt',
      'result',
      'error',
      'blocked_by_task_id',
      'blocked_by',
      'priority',
      'retry_count',
      'max_retries',
      'created_at',
      'updated_at',
      'completed_at',
    ];
    const actualNames = cfg.columns.map((c) => c.name);
    expect(actualNames).toEqual(expectedColumns);
  });

  it('id is text primary key', () => {
    expect(cols['id'].primary).toBe(true);
    expect(cols['id'].columnType).toBe('SQLiteText');
  });

  it('parent_id is text and indexed', () => {
    expect(cols['parent_id'].columnType).toBe('SQLiteText');
    expect(idxNames.has('idx_tasks_parent_id')).toBe(true);
    expect(idxCols['idx_tasks_parent_id']).toEqual(['parent_id']);
  });

  it('team_slug is text and indexed', () => {
    expect(cols['team_slug'].columnType).toBe('SQLiteText');
    expect(idxNames.has('idx_tasks_team_slug')).toBe(true);
    expect(idxCols['idx_tasks_team_slug']).toEqual(['team_slug']);
  });

  it('agent_aid is text and indexed', () => {
    expect(cols['agent_aid'].columnType).toBe('SQLiteText');
    expect(idxNames.has('idx_tasks_agent_aid')).toBe(true);
    expect(idxCols['idx_tasks_agent_aid']).toEqual(['agent_aid']);
  });

  it('jid is text and indexed', () => {
    expect(cols['jid'].columnType).toBe('SQLiteText');
    expect(idxNames.has('idx_tasks_jid')).toBe(true);
    expect(idxCols['idx_tasks_jid']).toEqual(['jid']);
  });

  it('status is integer and indexed (stores TaskStatus iota)', () => {
    expect(cols['status'].columnType).toBe('SQLiteInteger');
    expect(idxNames.has('idx_tasks_status')).toBe(true);
    expect(idxCols['idx_tasks_status']).toEqual(['status']);
  });

  it('prompt, result, error are text columns', () => {
    expect(cols['prompt'].columnType).toBe('SQLiteText');
    expect(cols['result'].columnType).toBe('SQLiteText');
    expect(cols['error'].columnType).toBe('SQLiteText');
  });

  it('created_at is timestamp (integer Unix ms) matching Go autoCreateTime', () => {
    expect(cols['created_at'].columnType).toBe('SQLiteTimestamp');
    expect(cols['created_at'].dataType).toBe('date');
    expect(cols['created_at'].notNull).toBe(true);
  });

  it('updated_at is timestamp (integer Unix ms) matching Go autoUpdateTime', () => {
    expect(cols['updated_at'].columnType).toBe('SQLiteTimestamp');
    expect(cols['updated_at'].dataType).toBe('date');
    expect(cols['updated_at'].notNull).toBe(true);
  });

  it('completed_at is nullable timestamp matching Go *time.Time', () => {
    expect(cols['completed_at'].columnType).toBe('SQLiteTimestamp');
    expect(cols['completed_at'].dataType).toBe('date');
    // nullable — notNull must be false to match Go *time.Time
    expect(cols['completed_at'].notNull).toBe(false);
  });

  it('blocked_by_task_id is text and indexed', () => {
    expect(cols['blocked_by_task_id'].columnType).toBe('SQLiteText');
    expect(idxNames.has('idx_tasks_blocked_by_task_id')).toBe(true);
    expect(idxCols['idx_tasks_blocked_by_task_id']).toEqual(['blocked_by_task_id']);
  });

  it('blocked_by is text with default "[]" (JSON array for task DAG)', () => {
    expect(cols['blocked_by'].columnType).toBe('SQLiteText');
    expect(cols['blocked_by'].notNull).toBe(true);
    expect(cols['blocked_by'].default).toBe('[]');
  });

  it('priority is integer with default 0', () => {
    expect(cols['priority'].columnType).toBe('SQLiteInteger');
    expect(cols['priority'].notNull).toBe(true);
    expect(cols['priority'].default).toBe(0);
  });

  it('priority is indexed', () => {
    expect(idxNames.has('idx_tasks_priority')).toBe(true);
    expect(idxCols['idx_tasks_priority']).toEqual(['priority']);
  });

  it('retry_count is integer with default 0', () => {
    expect(cols['retry_count'].columnType).toBe('SQLiteInteger');
    expect(cols['retry_count'].notNull).toBe(true);
    expect(cols['retry_count'].default).toBe(0);
  });

  it('max_retries is integer with default 0', () => {
    expect(cols['max_retries'].columnType).toBe('SQLiteInteger');
    expect(cols['max_retries'].notNull).toBe(true);
    expect(cols['max_retries'].default).toBe(0);
  });

  it('has exactly 7 indexes', () => {
    expect(cfg.indexes).toHaveLength(7);
  });

  it('all expected index names are present', () => {
    expect(idxNames.has('idx_tasks_parent_id')).toBe(true);
    expect(idxNames.has('idx_tasks_team_slug')).toBe(true);
    expect(idxNames.has('idx_tasks_agent_aid')).toBe(true);
    expect(idxNames.has('idx_tasks_jid')).toBe(true);
    expect(idxNames.has('idx_tasks_status')).toBe(true);
    expect(idxNames.has('idx_tasks_blocked_by_task_id')).toBe(true);
    expect(idxNames.has('idx_tasks_priority')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// messages table
// ---------------------------------------------------------------------------

describe('messages table', () => {
  const cfg = getTableConfig(messages);
  const cols = columnsByName(cfg);
  const idxNames = indexNames(cfg);
  const idxCols = indexColumns(cfg);

  it('table name is "messages" matching Go TableName()', () => {
    expect(cfg.name).toBe('messages');
    expect(getTableName(messages)).toBe('messages');
  });

  it('has exactly 5 columns matching Go MessageModel', () => {
    expect(cfg.columns).toHaveLength(5);
  });

  it('has all expected column names matching Go GORM column tags', () => {
    const expectedColumns = ['id', 'chat_jid', 'role', 'content', 'timestamp'];
    const actualNames = cfg.columns.map((c) => c.name);
    expect(actualNames).toEqual(expectedColumns);
  });

  it('id is text primary key', () => {
    expect(cols['id'].primary).toBe(true);
    expect(cols['id'].columnType).toBe('SQLiteText');
  });

  it('chat_jid is text and indexed', () => {
    expect(cols['chat_jid'].columnType).toBe('SQLiteText');
    expect(idxNames.has('idx_messages_chat_jid')).toBe(true);
    expect(idxCols['idx_messages_chat_jid']).toEqual(['chat_jid']);
  });

  it('role is text column', () => {
    expect(cols['role'].columnType).toBe('SQLiteText');
  });

  it('content is text column', () => {
    expect(cols['content'].columnType).toBe('SQLiteText');
  });

  it('timestamp is SQLiteTimestamp (integer Unix ms) and indexed', () => {
    expect(cols['timestamp'].columnType).toBe('SQLiteTimestamp');
    expect(cols['timestamp'].dataType).toBe('date');
    expect(idxNames.has('idx_messages_timestamp')).toBe(true);
    expect(idxCols['idx_messages_timestamp']).toEqual(['timestamp']);
  });

  it('has exactly 2 indexes matching Go GORM index tags', () => {
    expect(cfg.indexes).toHaveLength(2);
  });

  it('all expected index names are present', () => {
    expect(idxNames.has('idx_messages_chat_jid')).toBe(true);
    expect(idxNames.has('idx_messages_timestamp')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// log_entries table
// ---------------------------------------------------------------------------

describe('log_entries table', () => {
  const cfg = getTableConfig(log_entries);
  const cols = columnsByName(cfg);
  const idxNames = indexNames(cfg);
  const idxCols = indexColumns(cfg);

  it('table name is "log_entries" matching Go TableName()', () => {
    expect(cfg.name).toBe('log_entries');
    expect(getTableName(log_entries)).toBe('log_entries');
  });

  it('has exactly 13 columns matching Go LogEntryModel', () => {
    expect(cfg.columns).toHaveLength(13);
  });

  it('has all expected column names matching Go GORM column tags', () => {
    const expectedColumns = [
      'id',
      'level',
      'component',
      'action',
      'message',
      'params',
      'team_name',
      'task_id',
      'agent_name',
      'request_id',
      'error',
      'duration_ms',
      'created_at',
    ];
    const actualNames = cfg.columns.map((c) => c.name);
    expect(actualNames).toEqual(expectedColumns);
  });

  it('id is integer primary key with autoIncrement matching Go uint autoIncrement', () => {
    expect(cols['id'].primary).toBe(true);
    expect(cols['id'].columnType).toBe('SQLiteInteger');
    expect(cols['id'].autoIncrement).toBe(true);
  });

  it('level is integer and indexed (stores LogLevel iota)', () => {
    expect(cols['level'].columnType).toBe('SQLiteInteger');
    expect(idxNames.has('idx_log_entries_level')).toBe(true);
    expect(idxCols['idx_log_entries_level']).toEqual(['level']);
  });

  it('component is text and indexed', () => {
    expect(cols['component'].columnType).toBe('SQLiteText');
    expect(idxNames.has('idx_log_entries_component')).toBe(true);
    expect(idxCols['idx_log_entries_component']).toEqual(['component']);
  });

  it('action is text column', () => {
    expect(cols['action'].columnType).toBe('SQLiteText');
  });

  it('message is text column', () => {
    expect(cols['message'].columnType).toBe('SQLiteText');
  });

  it('params is text column (JSON string, matching Go type:text tag)', () => {
    expect(cols['params'].columnType).toBe('SQLiteText');
  });

  it('team_name is text and indexed', () => {
    expect(cols['team_name'].columnType).toBe('SQLiteText');
    expect(idxNames.has('idx_log_entries_team_name')).toBe(true);
    expect(idxCols['idx_log_entries_team_name']).toEqual(['team_name']);
  });

  it('task_id is text and indexed', () => {
    expect(cols['task_id'].columnType).toBe('SQLiteText');
    expect(idxNames.has('idx_log_entries_task_id')).toBe(true);
    expect(idxCols['idx_log_entries_task_id']).toEqual(['task_id']);
  });

  it('agent_name is text column', () => {
    expect(cols['agent_name'].columnType).toBe('SQLiteText');
  });

  it('request_id is text and indexed', () => {
    expect(cols['request_id'].columnType).toBe('SQLiteText');
    expect(idxNames.has('idx_log_entries_request_id')).toBe(true);
    expect(idxCols['idx_log_entries_request_id']).toEqual(['request_id']);
  });

  it('error is text column', () => {
    expect(cols['error'].columnType).toBe('SQLiteText');
  });

  it('duration_ms is integer column matching Go int64', () => {
    expect(cols['duration_ms'].columnType).toBe('SQLiteInteger');
  });

  it('created_at is SQLiteTimestamp (integer Unix ms) and indexed', () => {
    expect(cols['created_at'].columnType).toBe('SQLiteTimestamp');
    expect(cols['created_at'].dataType).toBe('date');
    expect(idxNames.has('idx_log_entries_created_at')).toBe(true);
    expect(idxCols['idx_log_entries_created_at']).toEqual(['created_at']);
  });

  it('has exactly 6 indexes matching Go GORM index tags', () => {
    expect(cfg.indexes).toHaveLength(6);
  });

  it('all expected index names are present', () => {
    expect(idxNames.has('idx_log_entries_level')).toBe(true);
    expect(idxNames.has('idx_log_entries_component')).toBe(true);
    expect(idxNames.has('idx_log_entries_team_name')).toBe(true);
    expect(idxNames.has('idx_log_entries_task_id')).toBe(true);
    expect(idxNames.has('idx_log_entries_request_id')).toBe(true);
    expect(idxNames.has('idx_log_entries_created_at')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// chat_sessions table
// ---------------------------------------------------------------------------

describe('chat_sessions table', () => {
  const cfg = getTableConfig(chat_sessions);
  const cols = columnsByName(cfg);

  it('table name is "chat_sessions" matching Go TableName()', () => {
    expect(cfg.name).toBe('chat_sessions');
    expect(getTableName(chat_sessions)).toBe('chat_sessions');
  });

  it('has exactly 6 columns matching Go ChatSessionModel', () => {
    expect(cfg.columns).toHaveLength(6);
  });

  it('has all expected column names matching Go GORM column tags', () => {
    const expectedColumns = [
      'chat_jid',
      'channel_type',
      'last_timestamp',
      'last_agent_timestamp',
      'session_id',
      'agent_aid',
    ];
    const actualNames = cfg.columns.map((c) => c.name);
    expect(actualNames).toEqual(expectedColumns);
  });

  it('chat_jid is text primary key matching Go primaryKey tag', () => {
    expect(cols['chat_jid'].primary).toBe(true);
    expect(cols['chat_jid'].columnType).toBe('SQLiteText');
  });

  it('channel_type is text column', () => {
    expect(cols['channel_type'].columnType).toBe('SQLiteText');
  });

  it('last_timestamp is SQLiteTimestamp (integer Unix ms) matching Go time.Time', () => {
    expect(cols['last_timestamp'].columnType).toBe('SQLiteTimestamp');
    expect(cols['last_timestamp'].dataType).toBe('date');
  });

  it('last_agent_timestamp is SQLiteTimestamp (integer Unix ms) matching Go time.Time', () => {
    expect(cols['last_agent_timestamp'].columnType).toBe('SQLiteTimestamp');
    expect(cols['last_agent_timestamp'].dataType).toBe('date');
  });

  it('session_id is text column', () => {
    expect(cols['session_id'].columnType).toBe('SQLiteText');
  });

  it('agent_aid is text column', () => {
    expect(cols['agent_aid'].columnType).toBe('SQLiteText');
  });

  it('has no indexes (Go ChatSessionModel has no index tags)', () => {
    expect(cfg.indexes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// escalations table
// ---------------------------------------------------------------------------

describe('escalations table', () => {
  const cfg = getTableConfig(escalations);
  const cols = columnsByName(cfg);
  const idxNames = indexNames(cfg);
  const idxCols = indexColumns(cfg);

  it('table name is "escalations"', () => {
    expect(cfg.name).toBe('escalations');
    expect(getTableName(escalations)).toBe('escalations');
  });

  it('has exactly 15 columns', () => {
    expect(cfg.columns).toHaveLength(15);
  });

  it('has all expected column names', () => {
    const expectedColumns = [
      'id',
      'correlation_id',
      'task_id',
      'from_aid',
      'to_aid',
      'source_team',
      'destination_team',
      'escalation_level',
      'reason',
      'context',
      'status',
      'resolution',
      'created_at',
      'updated_at',
      'resolved_at',
    ];
    const actualNames = cfg.columns.map((c) => c.name);
    expect(actualNames).toEqual(expectedColumns);
  });

  it('id is text primary key', () => {
    expect(cols['id'].primary).toBe(true);
    expect(cols['id'].columnType).toBe('SQLiteText');
  });

  it('correlation_id is text with index', () => {
    expect(cols['correlation_id'].columnType).toBe('SQLiteText');
    expect(idxNames.has('idx_escalations_correlation_id')).toBe(true);
  });

  it('escalation_level is integer', () => {
    expect(cols['escalation_level'].columnType).toBe('SQLiteInteger');
  });

  it('status is integer (stores escalation status enum)', () => {
    expect(cols['status'].columnType).toBe('SQLiteInteger');
    expect(idxNames.has('idx_escalations_status')).toBe(true);
  });

  it('resolved_at is nullable timestamp', () => {
    expect(cols['resolved_at'].columnType).toBe('SQLiteTimestamp');
    expect(cols['resolved_at'].notNull).toBe(false);
  });

  it('has exactly 6 indexes', () => {
    expect(cfg.indexes).toHaveLength(6);
  });

  it('all expected index names are present', () => {
    expect(idxNames.has('idx_escalations_correlation_id')).toBe(true);
    expect(idxNames.has('idx_escalations_task_id')).toBe(true);
    expect(idxNames.has('idx_escalations_from_aid')).toBe(true);
    expect(idxNames.has('idx_escalations_to_aid')).toBe(true);
    expect(idxNames.has('idx_escalations_status')).toBe(true);
    expect(idxNames.has('idx_escalations_created_id')).toBe(true);
  });

  it('indexes reference correct columns', () => {
    expect(idxCols['idx_escalations_correlation_id']).toEqual(['correlation_id']);
    expect(idxCols['idx_escalations_task_id']).toEqual(['task_id']);
    expect(idxCols['idx_escalations_from_aid']).toEqual(['from_aid']);
    expect(idxCols['idx_escalations_to_aid']).toEqual(['to_aid']);
    expect(idxCols['idx_escalations_status']).toEqual(['status']);
    expect(idxCols['idx_escalations_created_id']).toEqual(['created_at']);
  });
});

// ---------------------------------------------------------------------------
// agent_memories table
// ---------------------------------------------------------------------------

describe('agent_memories table', () => {
  const cfg = getTableConfig(agent_memories);
  const cols = columnsByName(cfg);
  const idxNames = indexNames(cfg);
  const idxCols = indexColumns(cfg);

  it('table name is "agent_memories"', () => {
    expect(cfg.name).toBe('agent_memories');
    expect(getTableName(agent_memories)).toBe('agent_memories');
  });

  it('has exactly 9 columns', () => {
    expect(cfg.columns).toHaveLength(9);
  });

  it('has all expected column names', () => {
    const expectedColumns = [
      'id',
      'agent_aid',
      'key',
      'value',
      'metadata',
      'team_slug',
      'deleted_at',
      'created_at',
      'updated_at',
    ];
    const actualNames = cfg.columns.map((c) => c.name);
    expect(actualNames).toEqual(expectedColumns);
  });

  it('id is text primary key', () => {
    expect(cols['id'].primary).toBe(true);
    expect(cols['id'].columnType).toBe('SQLiteText');
  });

  it('team_slug is text with notNull and default empty string', () => {
    expect(cols['team_slug'].columnType).toBe('SQLiteText');
    expect(cols['team_slug'].notNull).toBe(true);
    expect(cols['team_slug'].default).toBe('');
  });

  it('deleted_at is nullable timestamp', () => {
    expect(cols['deleted_at'].columnType).toBe('SQLiteTimestamp');
    expect(cols['deleted_at'].dataType).toBe('date');
    expect(cols['deleted_at'].notNull).toBe(false);
  });

  it('has exactly 4 indexes including composite and team_slug', () => {
    expect(cfg.indexes).toHaveLength(4);
  });

  it('all expected index names are present', () => {
    expect(idxNames.has('idx_agent_memories_agent_aid')).toBe(true);
    expect(idxNames.has('idx_agent_memories_key')).toBe(true);
    expect(idxNames.has('idx_agent_memories_agent_key')).toBe(true);
    expect(idxNames.has('idx_agent_memories_team_slug')).toBe(true);
  });

  it('composite index covers agent_aid and key', () => {
    expect(idxCols['idx_agent_memories_agent_key']).toEqual(['agent_aid', 'key']);
  });

  it('team_slug index references correct column', () => {
    expect(idxCols['idx_agent_memories_team_slug']).toEqual(['team_slug']);
  });
});

// ---------------------------------------------------------------------------
// triggers table
// ---------------------------------------------------------------------------

describe('triggers table', () => {
  const cfg = getTableConfig(triggers);
  const cols = columnsByName(cfg);
  const idxNames = indexNames(cfg);
  const idxCols = indexColumns(cfg);

  it('table name is "triggers"', () => {
    expect(cfg.name).toBe('triggers');
    expect(getTableName(triggers)).toBe('triggers');
  });

  it('has exactly 13 columns', () => {
    expect(cfg.columns).toHaveLength(13);
  });

  it('has all expected column names', () => {
    const expectedColumns = [
      'id',
      'name',
      'team_slug',
      'agent_aid',
      'schedule',
      'prompt',
      'enabled',
      'type',
      'webhook_path',
      'last_run_at',
      'next_run_at',
      'created_at',
      'updated_at',
    ];
    const actualNames = cfg.columns.map((c) => c.name);
    expect(actualNames).toEqual(expectedColumns);
  });

  it('id is text primary key', () => {
    expect(cols['id'].primary).toBe(true);
    expect(cols['id'].columnType).toBe('SQLiteText');
  });

  it('enabled is integer with default 1', () => {
    expect(cols['enabled'].columnType).toBe('SQLiteInteger');
    expect(cols['enabled'].default).toBe(1);
  });

  it('last_run_at and next_run_at are nullable timestamps', () => {
    expect(cols['last_run_at'].columnType).toBe('SQLiteTimestamp');
    expect(cols['last_run_at'].notNull).toBe(false);
    expect(cols['next_run_at'].columnType).toBe('SQLiteTimestamp');
    expect(cols['next_run_at'].notNull).toBe(false);
  });

  it('type is text with default "cron"', () => {
    expect(cols['type'].columnType).toBe('SQLiteText');
    expect(cols['type'].notNull).toBe(true);
    expect(cols['type'].default).toBe('cron');
  });

  it('webhook_path is text with default empty string', () => {
    expect(cols['webhook_path'].columnType).toBe('SQLiteText');
    expect(cols['webhook_path'].notNull).toBe(true);
    expect(cols['webhook_path'].default).toBe('');
  });

  it('has exactly 5 indexes', () => {
    expect(cfg.indexes).toHaveLength(5);
  });

  it('all expected index names are present', () => {
    expect(idxNames.has('idx_triggers_team_slug')).toBe(true);
    expect(idxNames.has('idx_triggers_agent_aid')).toBe(true);
    expect(idxNames.has('idx_triggers_enabled')).toBe(true);
    expect(idxNames.has('idx_triggers_next_run_at')).toBe(true);
    expect(idxNames.has('idx_triggers_webhook_path')).toBe(true);
  });

  it('indexes reference correct columns', () => {
    expect(idxCols['idx_triggers_team_slug']).toEqual(['team_slug']);
    expect(idxCols['idx_triggers_agent_aid']).toEqual(['agent_aid']);
    expect(idxCols['idx_triggers_enabled']).toEqual(['enabled']);
    expect(idxCols['idx_triggers_next_run_at']).toEqual(['next_run_at']);
    expect(idxCols['idx_triggers_webhook_path']).toEqual(['webhook_path']);
  });
});

// ---------------------------------------------------------------------------
// Cross-table: timestamp storage verification
// ---------------------------------------------------------------------------

describe('Timestamp storage (integer Unix ms)', () => {
  it('tasks timestamps use SQLiteTimestamp (stored as integer Unix ms)', () => {
    const cfg = getTableConfig(tasks);
    const cols = columnsByName(cfg);
    expect(cols['created_at'].columnType).toBe('SQLiteTimestamp');
    expect(cols['updated_at'].columnType).toBe('SQLiteTimestamp');
    expect(cols['completed_at'].columnType).toBe('SQLiteTimestamp');
    // All three have dataType 'date' — Drizzle maps Date ↔ integer automatically
    expect(cols['created_at'].dataType).toBe('date');
    expect(cols['updated_at'].dataType).toBe('date');
    expect(cols['completed_at'].dataType).toBe('date');
  });

  it('messages.timestamp uses SQLiteTimestamp (stored as integer Unix ms)', () => {
    const cfg = getTableConfig(messages);
    const cols = columnsByName(cfg);
    expect(cols['timestamp'].columnType).toBe('SQLiteTimestamp');
    expect(cols['timestamp'].dataType).toBe('date');
  });

  it('log_entries.created_at uses SQLiteTimestamp (stored as integer Unix ms)', () => {
    const cfg = getTableConfig(log_entries);
    const cols = columnsByName(cfg);
    expect(cols['created_at'].columnType).toBe('SQLiteTimestamp');
    expect(cols['created_at'].dataType).toBe('date');
  });

  it('chat_sessions timestamps use SQLiteTimestamp (stored as integer Unix ms)', () => {
    const cfg = getTableConfig(chat_sessions);
    const cols = columnsByName(cfg);
    expect(cols['last_timestamp'].columnType).toBe('SQLiteTimestamp');
    expect(cols['last_agent_timestamp'].columnType).toBe('SQLiteTimestamp');
    expect(cols['last_timestamp'].dataType).toBe('date');
    expect(cols['last_agent_timestamp'].dataType).toBe('date');
  });
});

// ---------------------------------------------------------------------------
// Cross-table: primary key verification
// ---------------------------------------------------------------------------

describe('Primary key definitions', () => {
  it('tasks.id is the only primary key (text)', () => {
    const cfg = getTableConfig(tasks);
    const pkCols = cfg.columns.filter((c) => c.primary);
    expect(pkCols).toHaveLength(1);
    expect(pkCols[0].name).toBe('id');
    expect(pkCols[0].columnType).toBe('SQLiteText');
  });

  it('messages.id is the only primary key (text)', () => {
    const cfg = getTableConfig(messages);
    const pkCols = cfg.columns.filter((c) => c.primary);
    expect(pkCols).toHaveLength(1);
    expect(pkCols[0].name).toBe('id');
    expect(pkCols[0].columnType).toBe('SQLiteText');
  });

  it('log_entries.id is the only primary key (integer autoincrement)', () => {
    const cfg = getTableConfig(log_entries);
    const pkCols = cfg.columns.filter((c) => c.primary);
    expect(pkCols).toHaveLength(1);
    expect(pkCols[0].name).toBe('id');
    expect(pkCols[0].columnType).toBe('SQLiteInteger');
    expect(pkCols[0].autoIncrement).toBe(true);
  });

  it('chat_sessions.chat_jid is the only primary key (text)', () => {
    const cfg = getTableConfig(chat_sessions);
    const pkCols = cfg.columns.filter((c) => c.primary);
    expect(pkCols).toHaveLength(1);
    expect(pkCols[0].name).toBe('chat_jid');
    expect(pkCols[0].columnType).toBe('SQLiteText');
  });
});
