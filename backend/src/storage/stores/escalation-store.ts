/**
 * Escalation store — SQLite-backed implementation of IEscalationStore.
 */

import { eq, or } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { IEscalationStore } from '../../domain/interfaces.js';
import type { EscalationCorrelation } from '../../domain/types.js';
import * as schema from '../schema.js';

export class EscalationStore implements IEscalationStore {
  constructor(private readonly db: BetterSQLite3Database<typeof schema>) {}

  create(correlation: EscalationCorrelation): void {
    this.db.insert(schema.escalationCorrelations).values({
      correlationId: correlation.correlationId,
      sourceTeam: correlation.sourceTeam,
      targetTeam: correlation.targetTeam,
      taskId: correlation.taskId,
      status: correlation.status,
      createdAt: correlation.createdAt,
    }).run();
  }

  updateStatus(correlationId: string, status: string): void {
    this.db
      .update(schema.escalationCorrelations)
      .set({ status })
      .where(eq(schema.escalationCorrelations.correlationId, correlationId))
      .run();
  }

  getByCorrelationId(id: string): EscalationCorrelation | undefined {
    const row = this.db
      .select()
      .from(schema.escalationCorrelations)
      .where(eq(schema.escalationCorrelations.correlationId, id))
      .get();

    if (!row) return undefined;

    return {
      correlationId: row.correlationId,
      sourceTeam: row.sourceTeam,
      targetTeam: row.targetTeam,
      taskId: row.taskId,
      status: row.status,
      createdAt: row.createdAt,
    };
  }

  removeByTeam(teamId: string): void {
    this.db.delete(schema.escalationCorrelations)
      .where(or(
        eq(schema.escalationCorrelations.sourceTeam, teamId),
        eq(schema.escalationCorrelations.targetTeam, teamId),
      ))
      .run();
  }
}
