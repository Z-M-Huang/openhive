/**
 * Containers page - lists all containers with health states and restart controls.
 * Implements AC-G7: containers list with color-coded health badges.
 * Implements AC-G16: restart confirmation modal with affected tasks and child teams.
 */

import { useState } from 'react';
import { useContainers, useRestartContainer } from '@/hooks/useApi';
import type { ContainerItem } from '@/types/api';
import { RotateCcw, X } from 'lucide-react';

// ---------------------------------------------------------------------------
// ContainerHealth tooltip descriptions (all 7 states from the backend enum)
// ---------------------------------------------------------------------------

const HEALTH_META: Record<string, { label: string; color: string; tooltip: string }> = {
  running: {
    label: 'Running',
    color: 'bg-green-700 text-green-100',
    tooltip: 'Container is healthy and receiving heartbeats.',
  },
  starting: {
    label: 'Starting',
    color: 'bg-blue-700 text-blue-100',
    tooltip: 'Container is initialising and has not yet sent a heartbeat.',
  },
  degraded: {
    label: 'Degraded',
    color: 'bg-yellow-700 text-yellow-100',
    tooltip: 'Heartbeat is late (one missed). Container may be slow.',
  },
  unhealthy: {
    label: 'Unhealthy',
    color: 'bg-orange-700 text-orange-100',
    tooltip: 'Missed 3+ heartbeats — container may recover on its own.',
  },
  unreachable: {
    label: 'Unreachable',
    color: 'bg-red-700 text-red-100',
    tooltip: 'No heartbeat for 90 s+. Container is likely crashed.',
  },
  stopping: {
    label: 'Stopping',
    color: 'bg-gray-500 text-gray-200',
    tooltip: 'Container is shutting down.',
  },
  stopped: {
    label: 'Stopped',
    color: 'bg-gray-700 text-gray-400',
    tooltip: 'Container has exited or was removed.',
  },
};

const FALLBACK_HEALTH = {
  label: 'Unknown',
  color: 'bg-gray-600 text-gray-300',
  tooltip: 'Health state is not recognised.',
};

// ---------------------------------------------------------------------------
// HealthBadge
// ---------------------------------------------------------------------------

function HealthBadge({ health }: { health: string }) {
  const meta = HEALTH_META[health] ?? { ...FALLBACK_HEALTH, label: health };
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded text-xs font-medium cursor-default ${meta.color}`}
      title={meta.tooltip}
      aria-label={`Health: ${meta.label} — ${meta.tooltip}`}
    >
      {meta.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Uptime formatter
// ---------------------------------------------------------------------------

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

// ---------------------------------------------------------------------------
// Restart confirmation modal
// ---------------------------------------------------------------------------

interface RestartModalProps {
  container: ContainerItem;
  isPending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function RestartModal({ container, isPending, onConfirm, onCancel }: RestartModalProps) {
  // Close on Escape key
  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape' && !isPending) {
      onCancel();
    }
  }

  // Prevent backdrop click from bubbling into modal content
  function handleBackdropClick() {
    if (!isPending) onCancel();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
      aria-hidden="false"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="restart-modal-title"
        aria-describedby="restart-modal-desc"
        className="relative bg-gray-800 border border-gray-600 rounded-lg shadow-xl w-full max-w-md mx-4 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button */}
        <button
          onClick={onCancel}
          disabled={isPending}
          className="absolute top-3 right-3 text-gray-400 hover:text-white disabled:opacity-40"
          aria-label="Cancel and close"
        >
          <X className="w-5 h-5" />
        </button>

        <h2 id="restart-modal-title" className="text-lg font-semibold text-white mb-2">
          Restart container "{container.slug}"?
        </h2>

        <div id="restart-modal-desc" className="space-y-3 text-sm text-gray-300 mb-6">
          <p>This will stop and restart the container. All running processes inside will be interrupted.</p>

          {container.activeTaskCount > 0 ? (
            <div className="bg-yellow-900/40 border border-yellow-700 rounded px-3 py-2">
              <span className="font-medium text-yellow-300">
                {container.activeTaskCount} active task{container.activeTaskCount !== 1 ? 's' : ''} will be interrupted.
              </span>
            </div>
          ) : (
            <p className="text-gray-500">No active tasks — safe to restart.</p>
          )}

          {container.childTeams.length > 0 && (
            <div>
              <p className="font-medium text-gray-200 mb-1">
                Child teams that will be affected ({container.childTeams.length}):
              </p>
              <ul className="list-disc list-inside space-y-0.5 text-gray-400">
                {container.childTeams.map((team) => (
                  <li key={team}>{team}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3">
          <button
            onClick={onCancel}
            disabled={isPending}
            className="px-4 py-2 text-sm rounded bg-gray-700 text-gray-200 hover:bg-gray-600 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isPending}
            className="px-4 py-2 text-sm rounded bg-red-700 text-white hover:bg-red-600 disabled:opacity-50 flex items-center gap-2"
            aria-busy={isPending}
          >
            {isPending && <RotateCcw className="w-4 h-4 animate-spin" aria-hidden="true" />}
            {isPending ? 'Restarting...' : 'Restart'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function Containers() {
  const containersQuery = useContainers();
  const restartMutation = useRestartContainer();

  // Track which container's modal is open (null = none)
  const [pendingRestart, setPendingRestart] = useState<ContainerItem | null>(null);

  const containers: ContainerItem[] = containersQuery.data?.containers ?? [];

  function openRestartModal(container: ContainerItem) {
    setPendingRestart(container);
  }

  function closeRestartModal() {
    if (!restartMutation.isPending) {
      setPendingRestart(null);
    }
  }

  function confirmRestart() {
    if (!pendingRestart) return;
    restartMutation.mutate(pendingRestart.slug, {
      onSuccess: () => {
        setPendingRestart(null);
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Containers</h1>
        <span className="text-sm text-gray-400">
          {containersQuery.isLoading
            ? 'Loading...'
            : `${containers.length} container${containers.length !== 1 ? 's' : ''}`}
        </span>
      </div>

      {/* Error state */}
      {containersQuery.isError && (
        <div className="bg-red-900/50 text-red-300 px-4 py-3 rounded">
          Failed to load containers:{' '}
          {containersQuery.error instanceof Error
            ? containersQuery.error.message
            : 'Unknown error'}
        </div>
      )}

      {/* Restart mutation error */}
      {restartMutation.isError && (
        <div className="bg-red-900/50 text-red-300 px-4 py-3 rounded">
          Restart failed:{' '}
          {restartMutation.error instanceof Error
            ? restartMutation.error.message
            : 'Unknown error'}
        </div>
      )}

      {/* Table */}
      <div className="bg-gray-800 rounded-lg overflow-hidden">
        <table className="w-full text-sm" aria-label="Containers table">
          <thead>
            <tr className="border-b border-gray-700">
              <th className="px-4 py-3 text-left text-gray-400 font-medium">Team slug</th>
              <th className="px-4 py-3 text-left text-gray-400 font-medium">Health</th>
              <th className="px-4 py-3 text-left text-gray-400 font-medium">Agents</th>
              <th className="px-4 py-3 text-left text-gray-400 font-medium">Uptime</th>
              <th className="px-4 py-3 text-left text-gray-400 font-medium">Restarts</th>
              <th className="px-4 py-3 text-left text-gray-400 font-medium">Active tasks</th>
              <th className="px-4 py-3 text-right text-gray-400 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {containersQuery.isLoading && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                  Loading containers...
                </td>
              </tr>
            )}
            {!containersQuery.isLoading && containers.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                  No containers found
                </td>
              </tr>
            )}
            {containers.map((c) => {
              const isRestarting =
                restartMutation.isPending && pendingRestart?.slug === c.slug;
              return (
                <tr
                  key={c.slug}
                  className="border-b border-gray-700/50 hover:bg-gray-700/30 transition-colors"
                >
                  <td className="px-4 py-3 font-medium text-white font-mono">{c.slug}</td>
                  <td className="px-4 py-3">
                    <HealthBadge health={c.health} />
                  </td>
                  <td className="px-4 py-3 text-gray-300">{c.agentCount}</td>
                  <td className="px-4 py-3 text-gray-300">{formatUptime(c.uptime)}</td>
                  <td className="px-4 py-3 text-gray-300">{c.restartCount}</td>
                  <td className="px-4 py-3 text-gray-300">{c.activeTaskCount}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => openRestartModal(c)}
                      disabled={isRestarting || restartMutation.isPending}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-gray-700 text-gray-200 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      aria-label={`Restart container ${c.slug}`}
                    >
                      <RotateCcw
                        className={`w-3.5 h-3.5 ${isRestarting ? 'animate-spin' : ''}`}
                        aria-hidden="true"
                      />
                      {isRestarting ? 'Restarting...' : 'Restart'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Restart confirmation modal */}
      {pendingRestart && (
        <RestartModal
          container={pendingRestart}
          isPending={restartMutation.isPending}
          onConfirm={confirmRestart}
          onCancel={closeRestartModal}
        />
      )}
    </div>
  );
}
