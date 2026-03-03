import { useCallback } from 'react';
import { useTeams } from '../hooks/useApi';
import type { Team } from '../hooks/useApi';
import { TeamNode } from '../components/teams/TeamNode';
import { useWebSocket } from '../hooks/useWebSocket';
import { queryClient } from '../lib/queryClient';
import type { WSMessage } from '../hooks/useWebSocket';

/**
 * Teams page: org chart visualization with real-time heartbeat status.
 * Root teams (no parent) appear at the top level.
 */
export function Teams(): React.JSX.Element {
  const { data: teams, isLoading, isError } = useTeams();

  // Listen for heartbeat and container state events to refresh team data
  const handleMessage = useCallback((msg: WSMessage): void => {
    const type = msg.type as string;
    if (
      type === 'heartbeat_received' ||
      type === 'container_state_changed' ||
      type === 'team_created' ||
      type === 'team_deleted'
    ) {
      void queryClient.invalidateQueries({ queryKey: ['teams'] });
    }
  }, []);

  useWebSocket({ onMessage: handleMessage });

  if (isLoading) {
    return (
      <div data-testid="teams-page">
        <h1 className="text-2xl font-bold mb-6">Teams</h1>
        <p className="text-sm text-muted-foreground">Loading teams...</p>
      </div>
    );
  }

  if (isError) {
    return (
      <div data-testid="teams-page">
        <h1 className="text-2xl font-bold mb-6">Teams</h1>
        <p className="text-sm text-destructive">Error loading teams</p>
      </div>
    );
  }

  // Build a lookup map for child team resolution
  const teamsMap: Record<string, Team> = {};
  for (const team of teams ?? []) {
    teamsMap[team.slug] = team;
  }

  // Root teams are those with no parent_slug
  const rootTeams = (teams ?? []).filter(t => !t.parent_slug);

  return (
    <div data-testid="teams-page">
      <h1 className="text-2xl font-bold mb-6">Teams</h1>

      {rootTeams.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No teams configured.
        </p>
      ) : (
        <div
          className="rounded-lg border border-border bg-card p-4 space-y-2"
          data-testid="org-chart"
        >
          {rootTeams.map(team => (
            <TeamNode
              key={team.slug}
              team={team}
              teamsMap={teamsMap}
              depth={0}
            />
          ))}
        </div>
      )}
    </div>
  );
}
