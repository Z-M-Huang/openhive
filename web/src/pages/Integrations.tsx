/**
 * Integrations page - lists all integrations with a lifecycle pipeline visualization.
 * Implements AC-G8: visual state pipeline, current state highlighted, error details for
 * failed/rolled_back states, config_path read-only field, optional team filter.
 */

import { useState } from 'react';
import { useIntegrations, useTeams } from '@/hooks/useApi';
import type { IntegrationItem } from '@/types/api';
import type { TeamSummary } from '@/types/api';

// ---------------------------------------------------------------------------
// Lifecycle pipeline definition
// ---------------------------------------------------------------------------

const PIPELINE_STAGES = ['proposed', 'validated', 'tested', 'approved', 'active'] as const;
type PipelineStage = (typeof PIPELINE_STAGES)[number];

const STAGE_LABELS: Record<PipelineStage, string> = {
  proposed: 'Proposed',
  validated: 'Validated',
  tested: 'Tested',
  approved: 'Approved',
  active: 'Active',
};

// Active/current stage color
const STAGE_ACTIVE_COLORS: Record<PipelineStage, string> = {
  proposed: 'bg-blue-700 text-blue-100 border-blue-500',
  validated: 'bg-indigo-700 text-indigo-100 border-indigo-500',
  tested: 'bg-violet-700 text-violet-100 border-violet-500',
  approved: 'bg-yellow-700 text-yellow-100 border-yellow-500',
  active: 'bg-green-700 text-green-100 border-green-500',
};

// Terminal state colors (not pipeline stages)
const TERMINAL_STATE_COLORS: Record<string, string> = {
  failed: 'bg-red-700 text-red-100',
  rolled_back: 'bg-gray-600 text-gray-300',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return the pipeline stage index, or -1 if status is not a pipeline stage. */
function stageIndex(status: string): number {
  return PIPELINE_STAGES.indexOf(status as PipelineStage);
}

/** True when the integration is in a terminal error state outside the pipeline. */
function isTerminalState(status: string): boolean {
  return status === 'failed' || status === 'rolled_back';
}

// ---------------------------------------------------------------------------
// LifecyclePipeline
// ---------------------------------------------------------------------------

function LifecyclePipeline({ status }: { status: string }) {
  const currentIdx = stageIndex(status);

  return (
    <div className="flex items-center gap-1" aria-label={`Lifecycle stage: ${status}`}>
      {PIPELINE_STAGES.map((stage, idx) => {
        const isCurrent = stage === status;
        const isPast = currentIdx >= 0 && idx < currentIdx;
        const isFuture = currentIdx >= 0 && idx > currentIdx;

        let cls: string;
        if (isCurrent) {
          cls = `border ${STAGE_ACTIVE_COLORS[stage]} font-semibold`;
        } else if (isPast) {
          cls = 'bg-gray-700 text-gray-400 border border-gray-600';
        } else if (isFuture) {
          cls = 'bg-gray-800 text-gray-600 border border-gray-700';
        } else {
          // Status is a terminal state — all stages are grayed out
          cls = 'bg-gray-800 text-gray-600 border border-gray-700';
        }

        return (
          <span key={stage} className="flex items-center gap-1">
            <span
              className={`px-2 py-0.5 rounded text-xs ${cls}`}
              aria-current={isCurrent ? 'step' : undefined}
            >
              {STAGE_LABELS[stage]}
            </span>
            {idx < PIPELINE_STAGES.length - 1 && (
              <span className={`text-xs ${isPast ? 'text-gray-500' : 'text-gray-700'}`} aria-hidden="true">
                →
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TerminalStateBadge
// ---------------------------------------------------------------------------

function TerminalStateBadge({ status, errorMessage }: { status: string; errorMessage?: string }) {
  const cls = TERMINAL_STATE_COLORS[status] ?? 'bg-gray-600 text-gray-300';
  const label = status === 'rolled_back' ? 'Rolled back' : status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <div className="space-y-1">
      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
        {label}
      </span>
      {errorMessage && errorMessage.length > 0 && (
        <p className="text-xs text-red-400 font-mono break-words" role="alert" aria-label="Error details">
          {errorMessage}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// IntegrationCard
// ---------------------------------------------------------------------------

function IntegrationCard({ integration }: { integration: IntegrationItem }) {
  const terminal = isTerminalState(integration.status);

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 space-y-3">
      {/* Header row */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-medium text-white">{integration.name}</p>
          <p className="text-xs text-gray-500 font-mono mt-0.5">{integration.id}</p>
        </div>
        <div className="text-xs text-gray-400 shrink-0">
          Team: <span className="text-gray-300">{integration.teamSlug}</span>
        </div>
      </div>

      {/* Lifecycle pipeline or terminal state badge */}
      {terminal ? (
        <div className="space-y-1">
          <TerminalStateBadge status={integration.status} errorMessage={integration.error_message} />
          {(!integration.error_message || integration.error_message.length === 0) && (
            <span className="text-xs text-gray-500 italic">
              Integration did not complete the lifecycle pipeline.
            </span>
          )}
        </div>
      ) : (
        <LifecyclePipeline status={integration.status} />
      )}

      {/* config_path (read-only) */}
      <div>
        <label className="block text-xs text-gray-500 mb-0.5">Config path</label>
        <input
          type="text"
          value={integration.config_path}
          readOnly
          aria-label={`Config path for ${integration.name}`}
          className="w-full bg-gray-900 border border-gray-700 text-gray-300 rounded px-2 py-1 text-xs font-mono focus:outline-none cursor-default"
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function Integrations() {
  const [teamFilter, setTeamFilter] = useState<string>('');

  const integrationsQuery = useIntegrations(teamFilter ? { team: teamFilter } : undefined);
  const teamsQuery = useTeams();

  const integrations: IntegrationItem[] = integrationsQuery.data?.integrations ?? [];
  const teams: TeamSummary[] = teamsQuery.data?.teams ?? [];

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Integrations</h1>
        <span className="text-sm text-gray-400">
          {integrationsQuery.isLoading
            ? 'Loading...'
            : `${integrations.length} integration${integrations.length !== 1 ? 's' : ''}`}
        </span>
      </div>

      {/* Team filter */}
      <div className="flex items-center gap-3">
        <label className="text-sm text-gray-400">Team:</label>
        <select
          value={teamFilter}
          onChange={(e) => setTeamFilter(e.target.value)}
          className="bg-gray-700 text-white px-3 py-1.5 rounded text-sm"
          aria-label="Filter by team"
        >
          <option value="">All teams</option>
          {teams.map((t) => (
            <option key={t.tid} value={t.slug}>
              {t.slug}
            </option>
          ))}
        </select>
        {teamFilter && (
          <button
            onClick={() => setTeamFilter('')}
            className="text-sm text-gray-400 hover:text-white"
          >
            Clear
          </button>
        )}
      </div>

      {/* Error state */}
      {integrationsQuery.isError && (
        <div className="bg-red-900/50 text-red-300 px-4 py-3 rounded">
          Failed to load integrations:{' '}
          {integrationsQuery.error instanceof Error
            ? integrationsQuery.error.message
            : 'Unknown error'}
        </div>
      )}

      {/* Loading state */}
      {integrationsQuery.isLoading && (
        <div className="text-gray-500 text-sm">Loading integrations...</div>
      )}

      {/* Empty state */}
      {!integrationsQuery.isLoading && integrations.length === 0 && !integrationsQuery.isError && (
        <div className="text-gray-500 text-sm">
          {teamFilter ? `No integrations for team "${teamFilter}"` : 'No integrations found'}
        </div>
      )}

      {/* Integration cards */}
      {integrations.length > 0 && (
        <div className="space-y-4">
          {integrations.map((integration) => (
            <IntegrationCard key={integration.id} integration={integration} />
          ))}
        </div>
      )}
    </div>
  );
}
