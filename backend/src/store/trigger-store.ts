/**
 * OpenHive Backend - Trigger Store
 *
 * Implements the TriggerStore interface using Drizzle ORM and better-sqlite3.
 * Provides persistence for automated trigger configurations.
 */

import { eq, and, desc, lte } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { DB } from './db.js';
import { triggers } from './schema.js';
import type * as schema from './schema.js';

import { NotFoundError } from '../domain/errors.js';
import type { Trigger } from '../domain/types.js';
import type { TriggerStore } from '../domain/interfaces.js';

// ---------------------------------------------------------------------------
// Row conversion helpers
// ---------------------------------------------------------------------------

function rowToDomain(row: typeof triggers.$inferSelect): Trigger {
  return {
    id: row.id,
    name: row.name,
    team_slug: row.team_slug,
    agent_aid: row.agent_aid,
    schedule: row.schedule,
    prompt: row.prompt,
    enabled: row.enabled === 1,
    type: (row.type as 'cron' | 'webhook') ?? 'cron',
    webhook_path: row.webhook_path ?? '',
    last_run_at: row.last_run_at ?? null,
    next_run_at: row.next_run_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function domainToRow(t: Trigger): typeof triggers.$inferInsert {
  return {
    id: t.id,
    name: t.name,
    team_slug: t.team_slug,
    agent_aid: t.agent_aid,
    schedule: t.schedule,
    prompt: t.prompt,
    enabled: t.enabled ? 1 : 0,
    type: t.type ?? 'cron',
    webhook_path: t.webhook_path ?? '',
    last_run_at: t.last_run_at ?? null,
    next_run_at: t.next_run_at ?? null,
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

// ---------------------------------------------------------------------------
// TriggerStoreImpl
// ---------------------------------------------------------------------------

export class TriggerStoreImpl implements TriggerStore {
  private readonly writer: BetterSQLite3Database<typeof schema>;
  private readonly reader: BetterSQLite3Database<typeof schema>;

  constructor(db: DB, reader?: BetterSQLite3Database<typeof schema>) {
    this.writer = db.writer;
    this.reader = reader ?? db.writer;
  }

  async create(trigger: Trigger): Promise<void> {
    this.writer.insert(triggers).values(domainToRow(trigger)).run();
  }

  async get(id: string): Promise<Trigger> {
    const rows = this.reader.select().from(triggers).where(eq(triggers.id, id)).all();
    if (rows.length === 0) {
      throw new NotFoundError('trigger', id);
    }
    return rowToDomain(rows[0]!);
  }

  async update(trigger: Trigger): Promise<void> {
    const result = this.writer
      .update(triggers)
      .set({
        name: trigger.name,
        team_slug: trigger.team_slug,
        agent_aid: trigger.agent_aid,
        schedule: trigger.schedule,
        prompt: trigger.prompt,
        enabled: trigger.enabled ? 1 : 0,
        type: trigger.type ?? 'cron',
        webhook_path: trigger.webhook_path ?? '',
        last_run_at: trigger.last_run_at ?? null,
        next_run_at: trigger.next_run_at ?? null,
        updated_at: trigger.updated_at,
      })
      .where(eq(triggers.id, trigger.id))
      .run();

    if (result.changes === 0) {
      throw new NotFoundError('trigger', trigger.id);
    }
  }

  async delete(id: string): Promise<void> {
    this.writer.delete(triggers).where(eq(triggers.id, id)).run();
  }

  async listByTeam(teamSlug: string): Promise<Trigger[]> {
    const rows = this.reader
      .select()
      .from(triggers)
      .where(eq(triggers.team_slug, teamSlug))
      .orderBy(desc(triggers.created_at))
      .all();
    return rows.map(rowToDomain);
  }

  async listEnabled(): Promise<Trigger[]> {
    const rows = this.reader
      .select()
      .from(triggers)
      .where(eq(triggers.enabled, 1))
      .orderBy(desc(triggers.created_at))
      .all();
    return rows.map(rowToDomain);
  }

  async listDue(now: Date): Promise<Trigger[]> {
    const rows = this.reader
      .select()
      .from(triggers)
      .where(and(eq(triggers.enabled, 1), lte(triggers.next_run_at, now)))
      .orderBy(triggers.next_run_at)
      .all();
    return rows.map(rowToDomain);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function newTriggerStore(
  db: DB,
  reader?: BetterSQLite3Database<typeof schema>,
): TriggerStoreImpl {
  return new TriggerStoreImpl(db, reader);
}
