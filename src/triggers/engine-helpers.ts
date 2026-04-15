/**
 * Small deterministic helpers for the trigger engine.
 *
 * Kept separate so the engine class stays focused on registration and
 * dispatch; these are pure functions with no engine state.
 */

import type { TriggerConfig } from '../domain/types.js';

/**
 * Tiny non-cryptographic string hash. Stable across process restarts.
 * Used to bucket messages into dedup event IDs.
 */
export function simpleHash(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Current minute-granularity slot used as a schedule-dedup discriminator. */
export function cronSlotKey(): string {
  return String(Math.floor(Date.now() / 60_000));
}

/**
 * Stable scope token for the subagent on a trigger. Uses a dash when absent
 * so the string form is deterministic and cannot collide with a real name.
 */
export function subagentScope(trigger: Pick<TriggerConfig, 'subagent'>): string {
  return trigger.subagent ?? '-';
}
