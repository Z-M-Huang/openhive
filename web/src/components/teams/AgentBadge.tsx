import type { AgentHeartbeatStatus } from '../../hooks/useApi';
import { cn } from '../../lib/utils';

interface AgentBadgeProps {
  aid: string;
  name: string;
  heartbeat?: AgentHeartbeatStatus;
}

const statusColors = {
  idle: 'bg-green-500',
  busy: 'bg-yellow-500',
  error: 'bg-red-500',
  stopped: 'bg-gray-400',
} as const;

/**
 * Agent status badge showing AID and heartbeat status dot.
 */
export function AgentBadge({ aid, name, heartbeat }: AgentBadgeProps): React.JSX.Element {
  const status = heartbeat?.status ?? 'stopped';
  const dotColor = statusColors[status as keyof typeof statusColors] ?? 'bg-gray-400';

  return (
    <div
      className="flex items-center gap-2 rounded px-2 py-1 bg-muted text-sm"
      data-testid={`agent-badge-${aid}`}
    >
      <span
        className={cn('h-2 w-2 rounded-full shrink-0', dotColor)}
        aria-label={`Agent status: ${status}`}
        data-testid={`agent-status-${aid}`}
      />
      <span className="font-medium">{name || aid}</span>
      <span className="text-xs text-muted-foreground font-mono">{aid}</span>
    </div>
  );
}
