/**
 * Learning- and reflection-cycle trigger seeding.
 *
 * Bug #1 (2026-04): seeding is NOT done at `spawn_team` time — at that
 * moment the team has no subagents yet, so we'd seed the wrong rows. The
 * actual seeding happens at two points where subagents are already known:
 *
 *   1. Startup bulk seed via `bootstrap-helpers.seedLearningTriggers`
 *      (iterates `.run/teams/{team}` and fans out to the per-team helper).
 *   2. Post-bootstrap hook in `sessions/task-consumer.ts` — fires
 *      immediately after a team's bootstrap task completes, so per-subagent
 *      rows appear as soon as the subagent files land on disk.
 *
 * AC-17 / AC-18: when a `subagent` is provided, the trigger is named
 * `learning-cycle-{subagent}` / `reflection-cycle-{subagent}` and scoped to
 * that subagent. When omitted, the generic trigger is seeded (only used
 * when a team has zero subagents).
 */

import type { ITriggerConfigStore } from '../../domain/interfaces.js';

/** Deterministic jittered cron from team name hash: runs daily at 2:{minute}. */
export function jitteredCron(teamName: string): string {
  const hash = Buffer.from(teamName).reduce((a, b) => a + b, 0);
  const minute = hash % 31;
  return `${minute} 2 * * *`;
}

/** Deterministic jittered cron for reflection: runs daily at 3:{minute} (offset from learning at 2:xx). */
export function reflectionJitteredCron(teamName: string): string {
  const hash = Buffer.from(teamName).reduce((a, b) => a + b, 0);
  const minute = hash % 31;
  return `${minute} 3 * * *`;
}

/**
 * Create an active learning-cycle trigger for a team (idempotent — skips if exists).
 *
 * AC-17: when `subagent` is provided, the trigger is scoped to that subagent —
 * the name becomes `learning-cycle-{subagent}` and the `subagent` field on
 * the trigger is set so the engine + task-consumer route the firing through
 * the named subagent. When `subagent` is omitted, the legacy generic
 * `learning-cycle` trigger is seeded (for teams that have no subagents
 * defined). Bootstrap-helpers discovers subagents and calls this once per
 * subagent; generic seeding is skipped when subagents exist.
 */
export function seedLearningTrigger(
  teamName: string,
  subagent?: string,
  store?: ITriggerConfigStore,
): void {
  if (!store) return;
  const name = subagent ? `learning-cycle-${subagent}` : 'learning-cycle';
  const existing = store.get(teamName, name);
  if (existing) return;
  store.upsert({
    name,
    type: 'schedule',
    config: { cron: jitteredCron(teamName) },
    team: teamName,
    task: 'Run a learning cycle: review recent interactions, extract patterns, and update memory.',
    state: 'active',
    overlapPolicy: 'always-skip',
    ...(subagent ? { subagent } : {}),
  });
}

/**
 * Create an active reflection-cycle trigger for a team (idempotent — skips if exists).
 *
 * AC-18: mirrors learning-cycle seeding — when `subagent` is provided, the
 * trigger is named `reflection-cycle-{subagent}` and scoped to that subagent.
 * Otherwise the legacy generic `reflection-cycle` trigger is seeded.
 */
export function seedReflectionTrigger(
  teamName: string,
  subagent?: string,
  store?: ITriggerConfigStore,
): void {
  if (!store) return;
  const name = subagent ? `reflection-cycle-${subagent}` : 'reflection-cycle';
  const existing = store.get(teamName, name);
  if (existing) return;
  store.upsert({
    name,
    type: 'schedule',
    config: { cron: reflectionJitteredCron(teamName) },
    team: teamName,
    task: 'Run a reflection cycle: review task outcomes and improve.',
    state: 'active',
    overlapPolicy: 'always-skip',
    maxSteps: 30,
    ...(subagent ? { subagent } : {}),
  });
}
