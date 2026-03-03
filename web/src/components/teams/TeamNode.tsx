import { useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import type { Team } from '../../hooks/useApi';
import { AgentBadge } from './AgentBadge';
import { cn } from '../../lib/utils';

interface TeamNodeProps {
  team: Team;
  teamsMap: Record<string, Team>;
  depth?: number;
}

const containerStateColors: Record<string, string> = {
  running: 'bg-green-500',
  starting: 'bg-yellow-500',
  error: 'bg-red-500',
  stopped: 'bg-gray-400',
};

/**
 * Recursive TeamNode component for the org chart tree.
 * Shows container state, agent count, and can expand to show agent list.
 */
export function TeamNode({ team, teamsMap, depth = 0 }: TeamNodeProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(depth === 0);
  const [agentsVisible, setAgentsVisible] = useState(false);

  const children = (team.children ?? [])
    .map(slug => teamsMap[slug])
    .filter(Boolean) as Team[];

  const containerState = team.container_state ?? 'stopped';
  const stateDot = containerStateColors[containerState] ?? 'bg-gray-400';
  const agentCount = team.agents?.length ?? 0;
  const hasChildren = children.length > 0;

  return (
    <div
      className={cn('border-l border-border pl-4', depth === 0 && 'border-l-0 pl-0')}
      data-testid={`team-node-${team.slug}`}
    >
      <div className="flex items-center gap-2 py-1.5">
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setExpanded(prev => !prev)}
            className="text-muted-foreground hover:text-foreground"
            aria-label={expanded ? 'Collapse' : 'Expand'}
            data-testid={`team-expand-${team.slug}`}
          >
            {expanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
        ) : (
          <span className="w-4" />
        )}

        {/* Container state indicator */}
        <span
          className={cn('h-2.5 w-2.5 rounded-full shrink-0', stateDot)}
          aria-label={`Container: ${containerState}`}
          data-testid={`team-state-${team.slug}`}
        />

        <span className="font-medium text-sm">{team.slug}</span>

        <span className="text-xs text-muted-foreground">
          {agentCount} agent{agentCount !== 1 ? 's' : ''}
        </span>

        {agentCount > 0 && (
          <button
            type="button"
            onClick={() => setAgentsVisible(prev => !prev)}
            className="text-xs text-muted-foreground hover:text-foreground underline"
            data-testid={`team-agents-toggle-${team.slug}`}
          >
            {agentsVisible ? 'Hide agents' : 'Show agents'}
          </button>
        )}
      </div>

      {/* Agent list */}
      {agentsVisible && team.agents && (
        <div
          className="ml-6 mt-1 mb-2 flex flex-wrap gap-2"
          data-testid={`team-agents-${team.slug}`}
        >
          {team.agents.map(agent => {
            const hb = team.heartbeat?.agents.find(a => a.aid === agent.aid);
            return (
              <AgentBadge
                key={agent.aid}
                aid={agent.aid}
                name={agent.name}
                heartbeat={hb}
              />
            );
          })}
        </div>
      )}

      {/* Child teams */}
      {expanded && hasChildren && (
        <div className="ml-4 mt-1">
          {children.map(child => (
            <TeamNode
              key={child.slug}
              team={child}
              teamsMap={teamsMap}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}
