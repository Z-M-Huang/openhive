/**
 * Trigger task option helpers.
 *
 * Single source of truth for snapshotting `subagent` + `maxSteps` from a
 * trigger config entry into a `TaskOptions` value. Used by:
 *   - `triggers/engine.ts` (cron-fire path)
 *   - `bootstrap-helpers.ts` (engine fallback when caller passed nothing)
 *   - `handlers/tools/test-trigger.ts` (manual fire path)
 *
 * Returns `undefined` when neither field is present so callers preserve their
 * existing "no options" branch — the task queue treats `undefined` as
 * "use defaults" rather than "explicitly empty".
 */

import type { TaskOptions } from '../domain/types.js';

export function buildTriggerTaskOptions(
  entry: { readonly subagent?: string; readonly maxSteps?: number } | undefined,
  maxStepsOverride?: number,
): TaskOptions | undefined {
  const subagent = entry?.subagent;
  const maxSteps = maxStepsOverride ?? entry?.maxSteps;
  if (subagent === undefined && maxSteps === undefined) return undefined;
  const opts: { -readonly [K in keyof TaskOptions]: TaskOptions[K] } = {};
  if (maxSteps !== undefined) opts.maxSteps = maxSteps;
  if (subagent !== undefined) opts.subagent = subagent;
  return opts;
}
