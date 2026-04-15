/**
 * Overlap-policy evaluation for the trigger engine.
 *
 * Extracted from `engine.ts` as pure functions over a narrow deps interface
 * so the engine class stays focused on dispatch. Policy semantics:
 *
 * - `allow`             — every firing creates a new task, no cancellation.
 * - `always-skip`       — if an active task exists, drop the new firing.
 * - `always-replace`    — if an active task exists, cancel it and create a new one.
 * - `skip-then-replace` — skip once, replace thereafter (the default).
 */

import type { ITaskQueueStore, ITriggerConfigStore } from '../domain/interfaces.js';
import type { TriggerConfig } from '../domain/types.js';
import { TaskStatus } from '../domain/types.js';

export interface OverlapPolicyDeps {
  readonly taskQueueStore?: ITaskQueueStore;
  readonly configStore?: ITriggerConfigStore;
  readonly abortSession?: (teamId: string, taskId: string) => void;
  readonly onOverlapAlert?: (
    team: string,
    triggerName: string,
    action: 'skipped' | 'replaced',
    details: { oldTaskId: string },
  ) => void;
}

/** Cancel an active task and notify via overlap alert. */
export function cancelAndReplace(
  deps: OverlapPolicyDeps,
  team: string,
  triggerName: string,
  oldTaskId: string,
): void {
  deps.taskQueueStore?.updateStatus(oldTaskId, TaskStatus.Cancelled);
  deps.abortSession?.(team, oldTaskId);
  deps.configStore?.resetOverlapState(team, triggerName);
  deps.onOverlapAlert?.(team, triggerName, 'replaced', { oldTaskId });
}

/**
 * Evaluate the overlap policy for a trigger firing.
 * Returns `true` when the firing should be *skipped* (no new task created).
 */
export function checkOverlapPolicy(
  deps: OverlapPolicyDeps,
  trigger: TriggerConfig,
  config: TriggerConfig | undefined,
  policy: string,
): boolean {
  if (policy === 'allow') return false;
  const activeTaskId = config?.activeTaskId;
  if (!activeTaskId) return false;

  const task = deps.taskQueueStore?.getById(activeTaskId);
  const isActive = task && (task.status === TaskStatus.Pending || task.status === TaskStatus.Running);

  if (!isActive) {
    // Stale reference — clear it
    deps.configStore?.clearActiveTask(trigger.team, trigger.name);
    deps.configStore?.setOverlapCount(trigger.team, trigger.name, 0);
    return false;
  }

  if (policy === 'always-skip') {
    deps.onOverlapAlert?.(trigger.team, trigger.name, 'skipped', { oldTaskId: activeTaskId });
    return true;
  }
  if (policy === 'always-replace') {
    cancelAndReplace(deps, trigger.team, trigger.name, activeTaskId);
    return false;
  }
  // skip-then-replace
  const overlapCount = config?.overlapCount ?? 0;
  if (overlapCount === 0) {
    deps.configStore?.setOverlapCount(trigger.team, trigger.name, 1);
    deps.onOverlapAlert?.(trigger.team, trigger.name, 'skipped', { oldTaskId: activeTaskId });
    return true;
  }
  cancelAndReplace(deps, trigger.team, trigger.name, activeTaskId);
  return false;
}
