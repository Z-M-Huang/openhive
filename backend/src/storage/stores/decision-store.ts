/**
 * DecisionStore implementation.
 *
 * @module storage/stores/decision-store
 */

import { eq, and, gte, asc } from 'drizzle-orm';
import type { Database } from '../database.js';
import * as schema from '../schema.js';
import type { DecisionStore } from '../../domain/interfaces.js';
import type { Decision } from '../../domain/domain.js';

export function newDecisionStore(db: Database): DecisionStore {
  return {
    async create(decision: Decision): Promise<void> {
      await db.enqueueWrite(() => {
        db.getDB().insert(schema.decisions).values({
          log_entry_id: decision.log_entry_id,
          decision_type: decision.decision_type,
          agent_aid: decision.agent_aid,
          task_id: decision.task_id,
          chosen_action: decision.chosen_action,
          alternatives: decision.alternatives,
          reasoning: decision.reasoning,
          created_at: decision.created_at,
        }).run();
      });
    },

    async getByTask(taskId: string): Promise<Decision[]> {
      const rows = db.getDB()
        .select()
        .from(schema.decisions)
        .where(eq(schema.decisions.task_id, taskId))
        .orderBy(asc(schema.decisions.created_at))
        .all();
      return rows as Decision[];
    },

    async getByAgent(agentAid: string, since: Date): Promise<Decision[]> {
      const ts = since.getTime();
      const rows = db.getDB()
        .select()
        .from(schema.decisions)
        .where(
          and(
            eq(schema.decisions.agent_aid, agentAid),
            gte(schema.decisions.created_at, ts),
          )
        )
        .orderBy(asc(schema.decisions.created_at))
        .all();
      return rows as Decision[];
    },

    async getByType(type: string, since: Date): Promise<Decision[]> {
      const ts = since.getTime();
      const rows = db.getDB()
        .select()
        .from(schema.decisions)
        .where(
          and(
            eq(schema.decisions.decision_type, type),
            gte(schema.decisions.created_at, ts),
          )
        )
        .orderBy(asc(schema.decisions.created_at))
        .all();
      return rows as Decision[];
    },
  };
}
