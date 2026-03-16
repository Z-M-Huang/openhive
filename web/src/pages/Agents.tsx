/**
 * Agents page - lists all agents across all teams with filtering and sorting.
 * Implements AC-G6: agents table with team filter, sortable columns, real-time status.
 */

import { useState, useCallback, useMemo } from 'react';
import { useAgents, useTeams } from '@/hooks/useApi';
import { usePortalWS } from '@/hooks/usePortalWS';
import type { AgentItem, WSEvent } from '@/types/api';
import type { TeamSummary } from '@/types/api';
import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SortKey = keyof Pick<AgentItem, 'name' | 'aid' | 'teamSlug' | 'role' | 'status' | 'modelTier'>;
type SortDir = 'asc' | 'desc';

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    idle: 'bg-gray-600 text-gray-200',
    active: 'bg-green-700 text-green-100',
    busy: 'bg-blue-700 text-blue-100',
    error: 'bg-red-700 text-red-100',
    stopped: 'bg-gray-700 text-gray-400',
  };
  const cls = colorMap[status] ?? 'bg-gray-600 text-gray-200';
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Sort icon helper
// ---------------------------------------------------------------------------

function SortIcon({ column, sortKey, sortDir }: { column: SortKey; sortKey: SortKey; sortDir: SortDir }) {
  if (column !== sortKey) return <ChevronsUpDown className="w-3 h-3 opacity-40" />;
  return sortDir === 'asc'
    ? <ChevronUp className="w-3 h-3" />
    : <ChevronDown className="w-3 h-3" />;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function Agents() {
  const [teamFilter, setTeamFilter] = useState<string>('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  // Live overrides from WS heartbeat: { [aid]: status }
  const [liveStatuses, setLiveStatuses] = useState<Record<string, string>>({});

  const agentsQuery = useAgents(teamFilter ? { team: teamFilter } : undefined);
  const teamsQuery = useTeams();

  // Subscribe to portal WS events for real-time status updates.
  // Heartbeat events carry agent status snapshots when agents are mentioned.
  const handleWsEvent = useCallback((event: WSEvent) => {
    if (event.type === 'heartbeat' && event.data.agents) {
      const agentsPayload = event.data.agents as Array<{ aid: string; status: string }>;
      if (Array.isArray(agentsPayload)) {
        setLiveStatuses((prev) => {
          const next = { ...prev };
          for (const a of agentsPayload) {
            if (a.aid && a.status) {
              next[a.aid] = a.status;
            }
          }
          return next;
        });
      }
    }
  }, []);

  usePortalWS({ onEvent: handleWsEvent });

  // Merge live statuses into agent list
  const agents: AgentItem[] = useMemo(() => {
    const base = agentsQuery.data?.agents ?? [];
    if (Object.keys(liveStatuses).length === 0) return base;
    return base.map((a) =>
      liveStatuses[a.aid] !== undefined
        ? { ...a, status: liveStatuses[a.aid] }
        : a
    );
  }, [agentsQuery.data, liveStatuses]);

  // Sort agents
  const sorted = useMemo(() => {
    return [...agents].sort((a, b) => {
      const aVal = a[sortKey] ?? '';
      const bVal = b[sortKey] ?? '';
      const cmp = String(aVal).localeCompare(String(bVal));
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [agents, sortKey, sortDir]);

  // Toggle or set sort column
  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  const teams: TeamSummary[] = teamsQuery.data?.teams ?? [];

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Agents</h1>
        <span className="text-sm text-gray-400">
          {agentsQuery.isLoading ? 'Loading...' : `${sorted.length} agent${sorted.length !== 1 ? 's' : ''}`}
        </span>
      </div>

      {/* Filters */}
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
      {agentsQuery.isError && (
        <div className="bg-red-900/50 text-red-300 px-4 py-3 rounded">
          Failed to load agents: {agentsQuery.error instanceof Error ? agentsQuery.error.message : 'Unknown error'}
        </div>
      )}

      {/* Table */}
      <div className="bg-gray-800 rounded-lg overflow-hidden">
        <table className="w-full text-sm" aria-label="Agents table">
          <thead>
            <tr className="border-b border-gray-700">
              {(
                [
                  { key: 'name', label: 'Name' },
                  { key: 'aid', label: 'AID' },
                  { key: 'teamSlug', label: 'Team' },
                  { key: 'role', label: 'Role' },
                  { key: 'status', label: 'Status' },
                  { key: 'modelTier', label: 'Model Tier' },
                ] as { key: SortKey; label: string }[]
              ).map(({ key, label }) => (
                <th
                  key={key}
                  className="px-4 py-3 text-left text-gray-400 font-medium cursor-pointer select-none hover:text-white"
                  onClick={() => handleSort(key)}
                  aria-sort={sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                >
                  <span className="flex items-center gap-1">
                    {label}
                    <SortIcon column={key} sortKey={sortKey} sortDir={sortDir} />
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {agentsQuery.isLoading && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                  Loading agents...
                </td>
              </tr>
            )}
            {!agentsQuery.isLoading && sorted.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                  {teamFilter ? `No agents in team "${teamFilter}"` : 'No agents found'}
                </td>
              </tr>
            )}
            {sorted.map((agent) => (
              <tr
                key={agent.aid}
                className="border-b border-gray-700/50 hover:bg-gray-700/30 transition-colors"
              >
                <td className="px-4 py-3 font-medium text-white">{agent.name}</td>
                <td className="px-4 py-3 text-gray-400 font-mono text-xs">{agent.aid}</td>
                <td className="px-4 py-3 text-gray-300">{agent.teamSlug}</td>
                <td className="px-4 py-3 text-gray-300">
                  {agent.role}
                  {agent.leadsTeam && (
                    <span className="ml-2 text-xs text-yellow-400">(lead)</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={agent.status} />
                </td>
                <td className="px-4 py-3 text-gray-400">{agent.modelTier}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
