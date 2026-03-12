/**
 * System health status card.
 */

import { useHealth } from '@/hooks/useApi';
import { usePortalWS } from '@/hooks/usePortalWS';
import { Server, Clock, Database, Wifi } from 'lucide-react';

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    healthy: 'bg-green-500',
    degraded: 'bg-yellow-500',
    unhealthy: 'bg-red-500',
  };

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs ${colors[status] ?? 'bg-gray-500'}`}>
      <span className="w-2 h-2 rounded-full bg-white" />
      {status}
    </span>
  );
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function SystemHealth() {
  const { data: health, isLoading, error } = useHealth();
  const { isConnected } = usePortalWS();

  if (isLoading) {
    return (
      <div className="bg-gray-800 rounded-lg p-6">
        <p className="text-gray-400">Loading system status...</p>
      </div>
    );
  }

  if (error || !health) {
    return (
      <div className="bg-gray-800 rounded-lg p-6">
        <p className="text-red-400">Failed to load system status</p>
      </div>
    );
  }

  return (
    <div className="bg-gray-800 rounded-lg p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">System Status</h2>
        <StatusBadge status={health.status} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="flex items-center gap-3">
          <Server className="w-5 h-5 text-gray-400" />
          <div>
            <p className="text-sm text-gray-400">Containers</p>
            <p className="text-xl font-semibold">{health.containers}</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Clock className="w-5 h-5 text-gray-400" />
          <div>
            <p className="text-sm text-gray-400">Uptime</p>
            <p className="text-xl font-semibold">{formatUptime(health.uptime)}</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Database className="w-5 h-5 text-gray-400" />
          <div>
            <p className="text-sm text-gray-400">Database</p>
            <p className="text-xl font-semibold capitalize">{health.dbStatus}</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Wifi className={`w-5 h-5 ${isConnected ? 'text-green-400' : 'text-red-400'}`} />
          <div>
            <p className="text-sm text-gray-400">WebSocket</p>
            <p className="text-xl font-semibold">{isConnected ? 'Connected' : 'Disconnected'}</p>
          </div>
        </div>
      </div>
    </div>
  );
}