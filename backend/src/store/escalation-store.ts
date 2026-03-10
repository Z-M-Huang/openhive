/**
 * OpenHive Backend - Escalation Store
 *
 * Implements the EscalationStore interface using Drizzle ORM and better-sqlite3.
 *
 * Escalation status is stored as an integer:
 *   pending=0, resolved=1, rejected=2, timed_out=3
 */

import { eq, desc } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { DB } from './db.js';
import { escalations } from './schema.js';
import type * as schema from './schema.js';

import { NotFoundError } from '../domain/errors.js';
import type { Escalation, EscalationStatus } from '../domain/types.js';
import type { EscalationStore } from '../domain/interfaces.js';

// ---------------------------------------------------------------------------
// Status conversion helpers
// ---------------------------------------------------------------------------

const ESCALATION_STATUSES: readonly EscalationStatus[] = [
  'pending',
  'resolved',
  'rejected',
  'timed_out',
];

function escalationStatusToInt(status: EscalationStatus): number {
  return ESCALATION_STATUSES.indexOf(status);
}

function intToEscalationStatus(n: number): EscalationStatus {
  const status = ESCALATION_STATUSES[n];
  if (status === undefined) {
    throw new Error(`unknown escalation status integer: ${n}`);
  }
  return status;
}

// ---------------------------------------------------------------------------
// Row conversion helpers
// ---------------------------------------------------------------------------

function rowToDomain(row: typeof escalations.$inferSelect): Escalation {
  return {
    id: row.id,
    correlation_id: row.correlation_id,
    task_id: row.task_id,
    from_aid: row.from_aid,
    to_aid: row.to_aid,
    source_team: row.source_team,
    destination_team: row.destination_team,
    escalation_level: row.escalation_level,
    reason: row.reason,
    context: row.context !== '' ? row.context : undefined,
    status: intToEscalationStatus(row.status),
    resolution: row.resolution !== '' ? row.resolution : undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    resolved_at: row.resolved_at ?? null,
  };
}

function domainToRow(e: Escalation): typeof escalations.$inferInsert {
  return {
    id: e.id,
    correlation_id: e.correlation_id,
    task_id: e.task_id,
    from_aid: e.from_aid,
    to_aid: e.to_aid,
    source_team: e.source_team,
    destination_team: e.destination_team,
    escalation_level: e.escalation_level,
    reason: e.reason,
    context: e.context ?? '',
    status: escalationStatusToInt(e.status),
    resolution: e.resolution ?? '',
    created_at: e.created_at,
    updated_at: e.updated_at,
    resolved_at: e.resolved_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// EscalationStoreImpl
// ---------------------------------------------------------------------------

export class EscalationStoreImpl implements EscalationStore {
  private readonly writer: BetterSQLite3Database<typeof schema>;
  private readonly reader: BetterSQLite3Database<typeof schema>;

  constructor(db: DB, reader?: BetterSQLite3Database<typeof schema>) {
    this.writer = db.writer;
    this.reader = reader ?? db.writer;
  }

  async create(escalation: Escalation): Promise<void> {
    this.writer.insert(escalations).values(domainToRow(escalation)).run();
  }

  async get(id: string): Promise<Escalation> {
    const rows = this.reader.select().from(escalations).where(eq(escalations.id, id)).all();
    if (rows.length === 0) {
      throw new NotFoundError('escalation', id);
    }
    return rowToDomain(rows[0]!);
  }

  async update(escalation: Escalation): Promise<void> {
    const result = this.writer
      .update(escalations)
      .set({
        correlation_id: escalation.correlation_id,
        task_id: escalation.task_id,
        from_aid: escalation.from_aid,
        to_aid: escalation.to_aid,
        source_team: escalation.source_team,
        destination_team: escalation.destination_team,
        escalation_level: escalation.escalation_level,
        reason: escalation.reason,
        context: escalation.context ?? '',
        status: escalationStatusToInt(escalation.status),
        resolution: escalation.resolution ?? '',
        updated_at: escalation.updated_at,
        resolved_at: escalation.resolved_at ?? null,
      })
      .where(eq(escalations.id, escalation.id))
      .run();

    if (result.changes === 0) {
      throw new NotFoundError('escalation', escalation.id);
    }
  }

  async listByAgent(aid: string): Promise<Escalation[]> {
    const rows = this.reader
      .select()
      .from(escalations)
      .where(eq(escalations.from_aid, aid))
      .orderBy(desc(escalations.created_at))
      .all();
    return rows.map(rowToDomain);
  }

  async listByStatus(status: EscalationStatus): Promise<Escalation[]> {
    const statusInt = escalationStatusToInt(status);
    const rows = this.reader
      .select()
      .from(escalations)
      .where(eq(escalations.status, statusInt))
      .orderBy(desc(escalations.created_at))
      .all();
    return rows.map(rowToDomain);
  }

  async listByCorrelation(correlationId: string): Promise<Escalation[]> {
    const rows = this.reader
      .select()
      .from(escalations)
      .where(eq(escalations.correlation_id, correlationId))
      .orderBy(desc(escalations.created_at))
      .all();
    return rows.map(rowToDomain);
  }

  async listByTask(taskId: string): Promise<Escalation[]> {
    const rows = this.reader
      .select()
      .from(escalations)
      .where(eq(escalations.task_id, taskId))
      .orderBy(desc(escalations.created_at))
      .all();
    return rows.map(rowToDomain);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function newEscalationStore(
  db: DB,
  reader?: BetterSQLite3Database<typeof schema>,
): EscalationStoreImpl {
  return new EscalationStoreImpl(db, reader);
}
