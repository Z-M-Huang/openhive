/**
 * Trigger config store — SQLite-backed implementation of ITriggerConfigStore.
 *
 * Stores trigger definitions with state, circuit breaker counters, and max_steps.
 */

import { eq, and } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { ITriggerConfigStore } from '../../domain/interfaces.js';
import type { TriggerConfig, TriggerState } from '../../domain/types.js';
import { safeJsonParse } from '../../domain/safe-json.js';
import * as schema from '../schema.js';

export class TriggerConfigStore implements ITriggerConfigStore {
  constructor(private readonly db: BetterSQLite3Database<typeof schema>) {}

  upsert(config: TriggerConfig): void {
    const now = new Date().toISOString();
    const existing = this.get(config.team, config.name);
    if (existing) {
      this.db.update(schema.triggerConfigs)
        .set({
          type: config.type,
          config: JSON.stringify(config.config),
          task: config.task,
          skill: config.skill ?? null,
          subagent: config.subagent ?? null,
          maxSteps: config.maxSteps ?? 100,
          failureThreshold: config.failureThreshold ?? 3,
          sourceChannelId: config.sourceChannelId ?? null,
          overlapPolicy: config.overlapPolicy ?? 'skip-then-replace',
          updatedAt: now,
        })
        .where(and(
          eq(schema.triggerConfigs.team, config.team),
          eq(schema.triggerConfigs.name, config.name),
        ))
        .run();
    } else {
      this.db.insert(schema.triggerConfigs).values({
        team: config.team,
        name: config.name,
        type: config.type,
        config: JSON.stringify(config.config),
        task: config.task,
        skill: config.skill ?? null,
        subagent: config.subagent ?? null,
        state: config.state ?? 'pending',
        maxSteps: config.maxSteps ?? 100,
        failureThreshold: config.failureThreshold ?? 3,
        consecutiveFailures: 0,
        sourceChannelId: config.sourceChannelId ?? null,
        overlapPolicy: config.overlapPolicy ?? 'skip-then-replace',
        createdAt: now,
        updatedAt: now,
      }).run();
    }
  }

  remove(team: string, name: string): void {
    this.db.delete(schema.triggerConfigs)
      .where(and(
        eq(schema.triggerConfigs.team, team),
        eq(schema.triggerConfigs.name, name),
      ))
      .run();
  }

  removeByTeam(team: string): void {
    this.db.delete(schema.triggerConfigs)
      .where(eq(schema.triggerConfigs.team, team))
      .run();
  }

  getByTeam(team: string): TriggerConfig[] {
    const rows = this.db.select().from(schema.triggerConfigs)
      .where(eq(schema.triggerConfigs.team, team))
      .all();
    return rows.map(r => this.rowToConfig(r));
  }

  getAll(): TriggerConfig[] {
    const rows = this.db.select().from(schema.triggerConfigs).all();
    return rows.map(r => this.rowToConfig(r));
  }

  setState(team: string, name: string, state: TriggerState, reason?: string): void {
    this.db.update(schema.triggerConfigs)
      .set({
        state,
        disabledReason: reason ?? null,
        updatedAt: new Date().toISOString(),
      })
      .where(and(
        eq(schema.triggerConfigs.team, team),
        eq(schema.triggerConfigs.name, name),
      ))
      .run();
  }

  incrementFailures(team: string, name: string): number {
    const entry = this.get(team, name);
    if (!entry) return 0;
    const newCount = (entry.consecutiveFailures ?? 0) + 1;
    this.db.update(schema.triggerConfigs)
      .set({
        consecutiveFailures: newCount,
        updatedAt: new Date().toISOString(),
      })
      .where(and(
        eq(schema.triggerConfigs.team, team),
        eq(schema.triggerConfigs.name, name),
      ))
      .run();
    return newCount;
  }

  resetFailures(team: string, name: string): void {
    this.db.update(schema.triggerConfigs)
      .set({
        consecutiveFailures: 0,
        updatedAt: new Date().toISOString(),
      })
      .where(and(
        eq(schema.triggerConfigs.team, team),
        eq(schema.triggerConfigs.name, name),
      ))
      .run();
  }

  setActiveTask(team: string, name: string, taskId: string): void {
    this.db.update(schema.triggerConfigs)
      .set({
        activeTaskId: taskId,
        updatedAt: new Date().toISOString(),
      })
      .where(and(
        eq(schema.triggerConfigs.team, team),
        eq(schema.triggerConfigs.name, name),
      ))
      .run();
  }

  clearActiveTask(team: string, name: string): void {
    this.db.update(schema.triggerConfigs)
      .set({
        activeTaskId: null,
        updatedAt: new Date().toISOString(),
      })
      .where(and(
        eq(schema.triggerConfigs.team, team),
        eq(schema.triggerConfigs.name, name),
      ))
      .run();
  }

  setOverlapCount(team: string, name: string, count: number): void {
    this.db.update(schema.triggerConfigs)
      .set({
        overlapCount: count,
        updatedAt: new Date().toISOString(),
      })
      .where(and(
        eq(schema.triggerConfigs.team, team),
        eq(schema.triggerConfigs.name, name),
      ))
      .run();
  }

  resetOverlapState(team: string, name: string): void {
    this.db.update(schema.triggerConfigs)
      .set({
        overlapCount: 0,
        activeTaskId: null,
        updatedAt: new Date().toISOString(),
      })
      .where(and(
        eq(schema.triggerConfigs.team, team),
        eq(schema.triggerConfigs.name, name),
      ))
      .run();
  }

  get(team: string, name: string): TriggerConfig | undefined {
    const row = this.db.select().from(schema.triggerConfigs)
      .where(and(
        eq(schema.triggerConfigs.team, team),
        eq(schema.triggerConfigs.name, name),
      ))
      .get();
    return row ? this.rowToConfig(row) : undefined;
  }

  private rowToConfig(row: typeof schema.triggerConfigs.$inferSelect): TriggerConfig {
    return {
      name: row.name,
      type: row.type as TriggerConfig['type'],
      config: safeJsonParse<Record<string, unknown>>(row.config, 'trigger-config') ?? {},
      team: row.team,
      task: row.task,
      skill: row.skill ?? undefined,
      subagent: row.subagent ?? undefined,
      state: row.state as TriggerState,
      maxSteps: row.maxSteps,
      failureThreshold: row.failureThreshold,
      consecutiveFailures: row.consecutiveFailures,
      disabledReason: row.disabledReason ?? undefined,
      sourceChannelId: row.sourceChannelId ?? undefined,
      overlapPolicy: (row.overlapPolicy as TriggerConfig['overlapPolicy']) ?? 'skip-then-replace',
      overlapCount: row.overlapCount ?? 0,
      activeTaskId: row.activeTaskId ?? null,
    };
  }
}
