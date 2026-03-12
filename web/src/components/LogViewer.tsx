/**
 * Log viewer component.
 */

import { useState } from 'react';
import { useLogs } from '@/hooks/useApi';
import { RefreshCw, Filter, AlertCircle, Info, AlertTriangle, Bug } from 'lucide-react';

function LevelIcon({ level }: { level: number }) {
  if (level >= 50) return <AlertCircle className="w-4 h-4 text-red-400" />;
  if (level >= 40) return <AlertTriangle className="w-4 h-4 text-orange-400" />;
  if (level >= 30) return <Info className="w-4 h-4 text-yellow-400" />;
  return <Bug className="w-4 h-4 text-gray-400" />;
}

function LevelBadge({ level }: { level: number }) {
  const labels: Record<number, string> = {
    0: 'trace',
    10: 'debug',
    20: 'info',
    30: 'warn',
    40: 'error',
    50: 'audit',
  };

  const colors: Record<number, string> = {
    0: 'text-gray-400',
    10: 'text-gray-400',
    20: 'text-blue-400',
    30: 'text-yellow-400',
    40: 'text-orange-400',
    50: 'text-red-400',
  };

  const label = labels[level] ?? 'unknown';
  const color = colors[level] ?? 'text-gray-400';

  return (
    <span className={`flex items-center gap-1 ${color}`}>
      <LevelIcon level={level} />
      {label}
    </span>
  );
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

export function LogViewer() {
  const [level, setLevel] = useState<number | undefined>(undefined);
  const [component, setComponent] = useState('');
  const { data, isLoading, error, refetch } = useLogs({
    level,
    component: component || undefined,
    limit: 100,
  });

  const entries = data?.entries ?? [];

  return (
    <div className="bg-gray-800 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <h2 className="font-semibold">Logs ({entries.length})</h2>
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
          value={level ?? ''}
          onChange={(e) => setLevel(e.target.value ? parseInt(e.target.value, 10) : undefined)}
          className="bg-gray-700 text-white px-3 py-1 rounded text-sm"
        >
          <option value="">All Levels</option>
          <option value="50">Audit</option>
          <option value="40">Error</option>
          <option value="30">Warn</option>
          <option value="20">Info</option>
          <option value="10">Debug</option>
          <option value="0">Trace</option>
        </select>
        <input
          type="text"
          placeholder="Component..."
          value={component}
          onChange={(e) => setComponent(e.target.value)}
          className="bg-gray-700 text-white px-3 py-1 rounded text-sm w-32"
        />
      </div>

      {isLoading ? (
        <div className="p-6">
          <p className="text-gray-400">Loading logs...</p>
        </div>
      ) : error ? (
        <div className="p-6">
          <p className="text-red-400">Failed to load logs</p>
        </div>
      ) : entries.length === 0 ? (
        <div className="p-6">
          <p className="text-gray-400">No log entries found</p>
        </div>
      ) : (
        <div className="divide-y divide-gray-700 max-h-[600px] overflow-y-auto">
          {entries.map((entry) => (
            <div key={entry.id} className="px-4 py-3 hover:bg-gray-750">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <LevelBadge level={entry.level} />
                  <span className="text-sm text-gray-300 truncate">{entry.component}</span>
                </div>
                <span className="text-xs text-gray-500 whitespace-nowrap">
                  {formatDate(entry.created_at)}
                </span>
              </div>
              <p className="mt-1 text-sm text-gray-200 break-all">{entry.message}</p>
              {entry.error && (
                <p className="mt-1 text-xs text-red-400 break-all">{entry.error}</p>
              )}
              <div className="mt-1 flex flex-wrap gap-2 text-xs text-gray-500">
                {entry.team_slug && <span>team: {entry.team_slug}</span>}
                {entry.task_id && <span>task: {entry.task_id}</span>}
                {entry.agent_aid && <span>agent: {entry.agent_aid}</span>}
                {entry.event_type && <span>event: {entry.event_type}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}