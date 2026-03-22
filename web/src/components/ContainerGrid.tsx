/**
 * Container cards grid component.
 */

import { useTeams } from '@/hooks/useApi';
import { Box, Users, Activity } from 'lucide-react';

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
    <span className={`px-2 py-1 rounded text-xs ${colors[health] ?? 'bg-gray-500'}`}>
      {health}
    </span>
  );
}

function ContainerCard({ team }: { team: {
  tid: string;
  slug: string;
  coordinatorAid: string;
  health: string;
  agentCount: number;
  depth: number;
} }) {
  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Box className="w-5 h-5 text-blue-400" />
          <h3 className="font-semibold">{team.slug}</h3>
        </div>
        <HealthBadge health={team.health} />
      </div>

      <div className="grid grid-cols-2 gap-2 text-sm">
        <div className="flex items-center gap-2 text-gray-400">
          <Users className="w-4 h-4" />
          <span>{team.agentCount} agents</span>
        </div>
        <div className="flex items-center gap-2 text-gray-400">
          <Activity className="w-4 h-4" />
          <span>Depth {team.depth}</span>
        </div>
      </div>

      <div className="mt-3 text-xs text-gray-500">
        Coordinator: {team.coordinatorAid}
      </div>
    </div>
  );
}

export function ContainerGrid() {
  const { data, isLoading, error } = useTeams();

  if (isLoading) {
    return (
      <div className="bg-gray-800 rounded-lg p-6">
        <p className="text-gray-400">Loading containers...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-gray-800 rounded-lg p-6">
        <p className="text-red-400">Failed to load containers</p>
      </div>
    );
  }

  const teams = data?.teams ?? [];

  if (teams.length === 0) {
    return (
      <div className="bg-gray-800 rounded-lg p-6">
        <p className="text-gray-400">No teams running</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {teams.map((team) => (
        <ContainerCard key={team.tid} team={team} />
      ))}
    </div>
  );
}