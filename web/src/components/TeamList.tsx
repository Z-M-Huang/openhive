/**
 * Team list component with org chart tree view as default.
 *
 * Displays teams in a hierarchical tree. Root teams (parentSlug undefined) are
 * top-level nodes. Children are nested under their parent. Tree nodes show slug,
 * health badge, agent count, and leader AID. Nodes are expandable/collapsible.
 * Clicking a tree node expands inline to show its agents.
 *
 * CSS-based indentation with connecting lines (border-left + padding-left). No
 * external tree library required.
 */

import { useState } from 'react';
import { useTeams, useAgents } from '@/hooks/useApi';
import { RefreshCw, ChevronRight, ChevronDown, Users } from 'lucide-react';
import type { TeamSummary } from '@/types/api';

// ---------------------------------------------------------------------------
// HealthBadge
// ---------------------------------------------------------------------------

function HealthBadge({ health }: { health: string }) {
  const colors: Record<string, string> = {
    running: 'bg-green-500',
    starting: 'bg-blue-500',
    degraded: 'bg-yellow-500',
    unhealthy: 'bg-red-500',
    unreachable: 'bg-red-700',
    stopping: 'bg-orange-500',
    stopped: 'bg-gray-500',
  };

  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${colors[health] ?? 'bg-gray-500'}`}>
      {health}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Expanded agent list panel
// ---------------------------------------------------------------------------

/**
 * Renders the inline agent list for an expanded team row.
 * Mounted only when the row is expanded, so the useAgents hook call is safe.
 */
function TeamAgentPanel({ team }: { team: TeamSummary }) {
  const { data, isLoading, error } = useAgents({ team: team.slug });

  if (isLoading) {
    return <p className="py-3 text-xs text-gray-500 italic">Loading agents...</p>;
  }
  if (error) {
    return <p className="py-3 text-xs text-red-400">Failed to load agents</p>;
  }

  const agents = data?.agents ?? [];

  if (agents.length === 0) {
    return <p className="py-3 text-xs text-gray-500 italic">No agents in this team</p>;
  }

  return (
    <ul className="divide-y divide-gray-700/50" aria-label={`Agents in ${team.slug}`}>
      {agents.map((agent) => (
        <li key={agent.aid} className="flex items-center gap-3 py-2 text-sm">
          <span className="font-mono text-xs text-gray-400 min-w-0 truncate flex-1" title={agent.aid}>
            {agent.name || agent.aid}
          </span>
          <span className="px-1.5 py-0.5 rounded text-xs bg-gray-700 text-gray-300 capitalize">
            {agent.role}
          </span>
          <span
            className={`px-1.5 py-0.5 rounded text-xs ${
              agent.status === 'idle'
                ? 'bg-green-900 text-green-300'
                : agent.status === 'running'
                  ? 'bg-blue-900 text-blue-300'
                  : 'bg-gray-700 text-gray-400'
            }`}
          >
            {agent.status}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Tree node type
// ---------------------------------------------------------------------------

interface TeamTreeNode {
  team: TeamSummary;
  children: TeamTreeNode[];
}

// ---------------------------------------------------------------------------
// Build tree from flat list
// ---------------------------------------------------------------------------

function buildTree(teams: TeamSummary[]): TeamTreeNode[] {
  const bySlug = new Map<string, TeamTreeNode>();

  // Create nodes
  for (const team of teams) {
    bySlug.set(team.slug, { team, children: [] });
  }

  const roots: TeamTreeNode[] = [];

  // Wire up children
  for (const team of teams) {
    const node = bySlug.get(team.slug)!;
    if (team.parentSlug && bySlug.has(team.parentSlug)) {
      bySlug.get(team.parentSlug)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

// ---------------------------------------------------------------------------
// TeamTreeRow
// ---------------------------------------------------------------------------

interface TeamTreeRowProps {
  node: TeamTreeNode;
  depth: number;
}

function TeamTreeRow({ node, depth }: TeamTreeRowProps) {
  const [expanded, setExpanded] = useState(false);
  const hasChildren = node.children.length > 0;
  const { team } = node;

  // Indentation: each depth level adds 24px padding + a connecting line
  const indentPx = depth * 24;

  return (
    <>
      {/* Team row */}
      <div
        className="flex items-center gap-2 px-4 py-2 border-b border-gray-700 hover:bg-gray-750 cursor-pointer select-none"
        role="treeitem"
        aria-expanded={hasChildren ? expanded : undefined}
        aria-label={`team ${team.slug}`}
        onClick={() => setExpanded((v) => !v)}
        style={{ paddingLeft: `${16 + indentPx}px` }}
        data-testid={`team-row-${team.slug}`}
      >
        {/* Expand/collapse chevron for teams with children */}
        <span className="w-4 h-4 flex-shrink-0 text-gray-400">
          {hasChildren ? (
            expanded ? (
              <ChevronDown className="w-4 h-4" />
            ) : (
              <ChevronRight className="w-4 h-4" />
            )
          ) : (
            <span className="w-4 h-4 block" aria-hidden="true" />
          )}
        </span>

        {/* Connecting line indicator for nested items */}
        {depth > 0 && (
          <span
            className="w-4 h-px bg-gray-600 flex-shrink-0"
            aria-hidden="true"
          />
        )}

        {/* Team slug */}
        <span className="font-medium text-sm min-w-0 flex-1 truncate">
          {team.slug}
        </span>

        {/* Health badge */}
        <HealthBadge health={team.health} />

        {/* Agent count */}
        <span
          className="flex items-center gap-1 text-xs text-gray-400 ml-2"
          title={`${team.agentCount} agent${team.agentCount !== 1 ? 's' : ''}`}
          aria-label={`${team.agentCount} agents`}
        >
          <Users className="w-3 h-3" />
          {team.agentCount}
        </span>

        {/* Coordinator AID */}
        <span className="text-xs text-gray-500 ml-2 truncate max-w-[160px]" title={team.coordinatorAid}>
          {team.coordinatorAid}
        </span>
      </div>

      {/* Inline agent list — shown when expanded (AC-G10) */}
      {expanded && (
        <div
          className="border-b border-gray-700 bg-gray-900"
          style={{ paddingLeft: `${16 + indentPx + 24}px` }}
          data-testid={`team-agents-${team.slug}`}
        >
          <div className="py-2 border-l-2 border-blue-500 pl-3">
            <p className="text-xs text-gray-400 mb-2 font-semibold uppercase tracking-wide">
              Agents
            </p>
            <TeamAgentPanel team={team} />
          </div>
        </div>
      )}

      {/* Render children with increased depth */}
      {expanded &&
        hasChildren &&
        node.children.map((child) => (
          <div
            key={child.team.tid}
            className="border-l border-gray-600"
            style={{ marginLeft: `${16 + indentPx + 24}px` }}
          >
            <TeamTreeRow node={child} depth={depth + 1} />
          </div>
        ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// TeamList (main export)
// ---------------------------------------------------------------------------

export function TeamList() {
  const { data, isLoading, error, refetch } = useTeams();

  if (isLoading) {
    return (
      <div className="bg-gray-800 rounded-lg p-6">
        <p className="text-gray-400">Loading teams...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-gray-800 rounded-lg p-6">
        <p className="text-red-400">Failed to load teams</p>
      </div>
    );
  }

  const teams = data?.teams ?? [];

  if (teams.length === 0) {
    return (
      <div className="bg-gray-800 rounded-lg p-6">
        <p className="text-gray-400">No teams configured</p>
      </div>
    );
  }

  const roots = buildTree(teams);

  return (
    <div className="bg-gray-800 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <h2 className="font-semibold">Teams ({teams.length})</h2>
        <button
          onClick={() => refetch()}
          className="p-2 text-gray-400 hover:text-white transition-colors"
          title="Refresh"
          aria-label="Refresh teams"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Column header row */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-700 text-xs font-semibold text-gray-400 uppercase tracking-wide">
        <span className="w-4 flex-shrink-0" aria-hidden="true" />
        <span className="flex-1">Slug</span>
        <span>Health</span>
        <span className="ml-2">Agents</span>
        <span className="ml-2 max-w-[160px]">Coordinator</span>
      </div>

      {/* Tree */}
      <div role="tree" aria-label="Teams hierarchy">
        {roots.map((root) => (
          <TeamTreeRow key={root.team.tid} node={root} depth={0} />
        ))}
      </div>
    </div>
  );
}
