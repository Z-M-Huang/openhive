/**
 * Team list table component.
 */

import { useState } from 'react';
import { useTeams, useDeleteTeam } from '@/hooks/useApi';
import { Box, Trash2, RefreshCw } from 'lucide-react';

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

export function TeamList() {
  const { data, isLoading, error, refetch } = useTeams();
  const deleteTeam = useDeleteTeam();
  const [deleting, setDeleting] = useState<string | null>(null);

  const handleDelete = async (slug: string) => {
    if (!confirm(`Delete team "${slug}"?`)) return;
    setDeleting(slug);
    try {
      await deleteTeam.mutateAsync(slug);
    } finally {
      setDeleting(null);
    }
  };

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

  return (
    <div className="bg-gray-800 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <h2 className="font-semibold">Teams ({teams.length})</h2>
        <button
          onClick={() => refetch()}
          className="p-2 text-gray-400 hover:text-white transition-colors"
          title="Refresh"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="text-left text-sm text-gray-400 border-b border-gray-700">
              <th className="px-4 py-3">Slug</th>
              <th className="px-4 py-3">Health</th>
              <th className="px-4 py-3">Agents</th>
              <th className="px-4 py-3">Depth</th>
              <th className="px-4 py-3">Leader</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {teams.map((team) => (
              <tr key={team.tid} className="border-b border-gray-700 hover:bg-gray-750">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Box className="w-4 h-4 text-blue-400" />
                    {team.slug}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <HealthBadge health={team.health} />
                </td>
                <td className="px-4 py-3">{team.agentCount}</td>
                <td className="px-4 py-3">{team.depth}</td>
                <td className="px-4 py-3 text-sm text-gray-400">{team.leaderAid}</td>
                <td className="px-4 py-3">
                  <button
                    onClick={() => handleDelete(team.slug)}
                    disabled={deleting === team.slug}
                    className="p-2 text-red-400 hover:text-red-300 disabled:opacity-50 transition-colors"
                    title="Delete team"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}