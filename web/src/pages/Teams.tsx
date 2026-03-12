/**
 * Teams page - team management.
 */

import { useState } from 'react';
import { TeamList } from '@/components/TeamList';
import { useCreateTeam } from '@/hooks/useApi';
import { Plus } from 'lucide-react';

export function Teams() {
  const [newSlug, setNewSlug] = useState('');
  const createTeam = useCreateTeam();

  const handleCreate = async () => {
    if (!newSlug.trim()) return;
    try {
      await createTeam.mutateAsync(newSlug.trim());
      setNewSlug('');
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Failed to create team');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Teams</h1>
      </div>

      {/* Create team form */}
      <div className="bg-gray-800 rounded-lg p-4">
        <h2 className="text-sm font-semibold text-gray-400 mb-3">Create New Team</h2>
        <div className="flex gap-3">
          <input
            type="text"
            placeholder="team-slug"
            value={newSlug}
            onChange={(e) => setNewSlug(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            className="flex-1 bg-gray-700 text-white px-4 py-2 rounded"
          />
          <button
            onClick={handleCreate}
            disabled={!newSlug.trim() || createTeam.isPending}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded"
          >
            <Plus className="w-4 h-4" />
            Create
          </button>
        </div>
      </div>

      {/* Team list */}
      <TeamList />
    </div>
  );
}