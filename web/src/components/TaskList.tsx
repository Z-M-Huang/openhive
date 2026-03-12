/**
 * Task list component.
 */

import { useState } from 'react';
import { useTasks } from '@/hooks/useApi';
import { RefreshCw, Filter } from 'lucide-react';

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: 'bg-gray-500',
    active: 'bg-blue-500',
    completed: 'bg-green-500',
    failed: 'bg-red-500',
    escalated: 'bg-orange-500',
    cancelled: 'bg-gray-600',
  };

  return (
    <span className={`px-2 py-1 rounded text-xs ${colors[status] ?? 'bg-gray-500'}`}>
      {status}
    </span>
  );
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

export function TaskList() {
  const [status, setStatus] = useState<string>('');
  const [team, setTeam] = useState<string>('');
  const { data, isLoading, error, refetch } = useTasks({
    status: status || undefined,
    team: team || undefined,
    limit: 50,
  });

  const tasks = data?.tasks ?? [];

  return (
    <div className="bg-gray-800 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <h2 className="font-semibold">Tasks ({data?.total ?? 0})</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => refetch()}
            className="p-2 text-gray-400 hover:text-white transition-colors"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-4 px-4 py-3 border-b border-gray-700 bg-gray-750">
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-gray-400" />
          <span className="text-sm text-gray-400">Filters:</span>
        </div>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="bg-gray-700 text-white px-3 py-1 rounded text-sm"
        >
          <option value="">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="active">Active</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="escalated">Escalated</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <input
          type="text"
          placeholder="Team slug..."
          value={team}
          onChange={(e) => setTeam(e.target.value)}
          className="bg-gray-700 text-white px-3 py-1 rounded text-sm w-32"
        />
      </div>

      {isLoading ? (
        <div className="p-6">
          <p className="text-gray-400">Loading tasks...</p>
        </div>
      ) : error ? (
        <div className="p-6">
          <p className="text-red-400">Failed to load tasks</p>
        </div>
      ) : tasks.length === 0 ? (
        <div className="p-6">
          <p className="text-gray-400">No tasks found</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-left text-sm text-gray-400 border-b border-gray-700">
                <th className="px-4 py-3">Title</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Team</th>
                <th className="px-4 py-3">Agent</th>
                <th className="px-4 py-3">Created</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr key={task.id} className="border-b border-gray-700 hover:bg-gray-750">
                  <td className="px-4 py-3">
                    <div className="max-w-xs truncate" title={task.title}>
                      {task.title}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={task.status} />
                  </td>
                  <td className="px-4 py-3 text-sm">{task.team_slug}</td>
                  <td className="px-4 py-3 text-sm text-gray-400">{task.agent_aid || '-'}</td>
                  <td className="px-4 py-3 text-sm text-gray-400">{formatDate(task.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}