/**
 * ToolCallStore implementation.
 *
 * @module storage/stores/tool-call-store
 */

import { eq, and, gte, asc } from 'drizzle-orm';
import type { Database } from '../database.js';
import * as schema from '../schema.js';
import type { ToolCallStore } from '../../domain/interfaces.js';
import type { ToolCall } from '../../domain/domain.js';

export function newToolCallStore(db: Database): ToolCallStore {
  return {
    async create(call: ToolCall): Promise<void> {
      await db.enqueueWrite(() => {
        db.getDB().insert(schema.toolCalls).values({
          log_entry_id: call.log_entry_id,
          tool_use_id: call.tool_use_id,
          tool_name: call.tool_name,
          agent_aid: call.agent_aid,
          team_slug: call.team_slug,
          task_id: call.task_id,
          params: call.params,
          result_summary: call.result_summary,
          error: call.error,
          duration_ms: call.duration_ms,
          created_at: call.created_at,
        }).run();
      });
    },

    async getByTask(taskId: string): Promise<ToolCall[]> {
      const rows = db.getDB()
        .select()
        .from(schema.toolCalls)
        .where(eq(schema.toolCalls.task_id, taskId))
        .orderBy(asc(schema.toolCalls.created_at))
        .all();
      return rows as ToolCall[];
    },

    async getByAgent(agentAid: string, since: Date): Promise<ToolCall[]> {
      const ts = since.getTime();
      const rows = db.getDB()
        .select()
        .from(schema.toolCalls)
        .where(
          and(
            eq(schema.toolCalls.agent_aid, agentAid),
            gte(schema.toolCalls.created_at, ts),
          )
        )
        .orderBy(asc(schema.toolCalls.created_at))
        .all();
      return rows as ToolCall[];
    },

    async getByToolName(toolName: string, since: Date): Promise<ToolCall[]> {
      const ts = since.getTime();
      const rows = db.getDB()
        .select()
        .from(schema.toolCalls)
        .where(
          and(
            eq(schema.toolCalls.tool_name, toolName),
            gte(schema.toolCalls.created_at, ts),
          )
        )
        .orderBy(asc(schema.toolCalls.created_at))
        .all();
      return rows as ToolCall[];
    },
  };
}
