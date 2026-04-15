import type { ITaskQueueStore } from '../../domain/interfaces.js';
import { TaskStatus } from '../../domain/types.js';
import type { TaskEntry } from '../../domain/types.js';

export type InteractiveOverlapPolicy = 'allow' | 'skip' | 'replace' | 'confirm';

export type TeamBusyDecision = 'proceed' | 'skip' | 'needs_confirmation';

export interface TeamBusyResult {
  inFlight: TaskEntry[];
  decision: TeamBusyDecision;
  replacedTaskIds?: string[];
  reason?: 'replace_targets_running_session';
}

export interface CheckTeamBusyOpts {
  policy: InteractiveOverlapPolicy;
  staleAfterMs?: number; // default 600_000
  now?: () => number;    // default Date.now (for test injection)
}

export function checkTeamBusy(
  teamId: string,
  deps: Pick<ITaskQueueStore, 'getActiveForTeam' | 'updateStatus'>,
  opts: CheckTeamBusyOpts,
): TeamBusyResult {
  const staleAfterMs = opts.staleAfterMs ?? 600_000;
  const nowMs = opts.now?.() ?? Date.now();

  const inFlight = deps.getActiveForTeam(teamId);

  // No active tasks — always proceed regardless of policy.
  if (inFlight.length === 0) {
    return { decision: 'proceed', inFlight: [] };
  }

  switch (opts.policy) {
    case 'allow':
      return { decision: 'proceed', inFlight };

    case 'skip':
      return { decision: 'skip', inFlight };

    case 'confirm':
      return { decision: 'needs_confirmation', inFlight };

    case 'replace': {
      const pendingIds: string[] = [];
      const staleRunningIds: string[] = [];
      const nonStaleRunningIds: string[] = [];

      for (const entry of inFlight) {
        if (entry.status === TaskStatus.Pending) {
          pendingIds.push(entry.id);
        } else if (entry.status === TaskStatus.Running) {
          const ageMs = nowMs - new Date(entry.createdAt).getTime();
          if (ageMs > staleAfterMs) {
            staleRunningIds.push(entry.id);
          } else {
            nonStaleRunningIds.push(entry.id);
          }
        }
      }

      // Non-stale running sessions cannot be cancelled — downgrade to confirmation.
      if (nonStaleRunningIds.length > 0) {
        return {
          decision: 'needs_confirmation',
          inFlight,
          reason: 'replace_targets_running_session',
        };
      }

      // Cancel all pending and stale-running rows.
      const toCancel = [...pendingIds, ...staleRunningIds];
      for (const id of toCancel) {
        deps.updateStatus(id, TaskStatus.Cancelled);
      }

      return { decision: 'proceed', inFlight, replacedTaskIds: toCancel };
    }
  }
}
