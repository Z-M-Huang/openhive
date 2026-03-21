/**
 * Shared helpers for store implementations.
 *
 * @module storage/stores/helpers
 */

import type {
  Task,
  LogEntry,
  MemoryEntry,
} from '../../domain/domain.js';
import type { TaskStatus } from '../../domain/enums.js';
import * as schema from '../schema.js';

/** Parse blocked_by JSON string to string[], or return empty array. */
export function parseBlockedBy(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as string[];
    return [];
  } catch {
    return [];
  }
}

/** Convert DB row to Task domain type. */
export function rowToTask(row: typeof schema.tasks.$inferSelect): Task {
  return {
    id: row.id,
    parent_id: row.parent_id,
    team_slug: row.team_slug,
    agent_aid: row.agent_aid,
    title: row.title,
    status: row.status as TaskStatus,
    prompt: row.prompt,
    result: row.result,
    error: row.error,
    blocked_by: parseBlockedBy(row.blocked_by),
    priority: row.priority,
    retry_count: row.retry_count,
    max_retries: row.max_retries,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at ?? null,
    origin_chat_jid: (row as Record<string, unknown>).origin_chat_jid as string | null ?? null,
  };
}

/** Convert DB row to LogEntry domain type. */
export function rowToLogEntry(row: typeof schema.logEntries.$inferSelect): LogEntry {
  return {
    id: row.id,
    level: row.level as LogEntry['level'],
    event_type: row.event_type,
    component: row.component,
    action: row.action,
    message: row.message,
    params: row.params,
    team_slug: row.team_slug,
    task_id: row.task_id,
    agent_aid: row.agent_aid,
    request_id: row.request_id,
    correlation_id: row.correlation_id,
    error: row.error,
    duration_ms: row.duration_ms,
    created_at: row.created_at,
  };
}

/** Convert DB row to MemoryEntry domain type. */
export function rowToMemoryEntry(row: typeof schema.agentMemories.$inferSelect): MemoryEntry {
  return {
    id: row.id,
    agent_aid: row.agent_aid,
    team_slug: row.team_slug,
    content: row.content,
    memory_type: row.memory_type as MemoryEntry['memory_type'],
    created_at: row.created_at,
    deleted_at: row.deleted_at ?? null,
  };
}

/** Valid integration status transitions. */
export const VALID_INTEGRATION_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  proposed: new Set(['validated']),
  validated: new Set(['tested']),
  tested: new Set(['approved']),
  approved: new Set(['active']),
  active: new Set(['failed', 'rolled_back']),
  failed: new Set<string>(),
  rolled_back: new Set<string>(),
};
