import type { Task } from '../../hooks/useApi';
import { cn } from '../../lib/utils';

interface TaskRowProps {
  task: Task;
  onClick: (task: Task) => void;
  style?: React.CSSProperties;
}

const statusColors: Record<string, string> = {
  pending: 'text-gray-500 bg-gray-100 dark:bg-gray-800',
  running: 'text-blue-600 bg-blue-50 dark:bg-blue-900/30',
  completed: 'text-green-600 bg-green-50 dark:bg-green-900/30',
  failed: 'text-red-600 bg-red-50 dark:bg-red-900/30',
  cancelled: 'text-yellow-600 bg-yellow-50 dark:bg-yellow-900/30',
};

function formatDuration(createdAt: string, updatedAt: string): string {
  const created = new Date(createdAt).getTime();
  const updated = new Date(updatedAt).getTime();
  const ms = updated - created;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60000)}m`;
}

/**
 * A single row in the task table.
 */
export function TaskRow({ task, onClick, style }: TaskRowProps): React.JSX.Element {
  const statusColor = statusColors[task.status] ?? statusColors.pending;
  const shortID = task.id.slice(-8);
  const time = new Date(task.created_at).toLocaleTimeString();
  const duration = formatDuration(task.created_at, task.updated_at);

  return (
    <div
      style={style}
      className="border-b border-border hover:bg-accent/30 transition-colors cursor-pointer"
      data-testid={`task-row-${task.id}`}
    >
      <button
        type="button"
        className="w-full text-left px-4 py-2.5 flex items-center gap-3"
        onClick={() => onClick(task)}
      >
        <span className="text-xs font-mono text-muted-foreground w-20 shrink-0">
          ...{shortID}
        </span>
        <span
          className={cn(
            'text-xs font-medium rounded px-1.5 py-0.5 w-20 text-center shrink-0',
            statusColor,
          )}
          data-testid={`task-status-${task.id}`}
        >
          {task.status}
        </span>
        <span className="text-xs text-muted-foreground w-24 shrink-0 truncate">
          {task.team_slug}
        </span>
        <span className="text-sm truncate flex-1">{task.prompt}</span>
        <span className="text-xs text-muted-foreground shrink-0">{duration}</span>
        <span className="text-xs text-muted-foreground shrink-0">{time}</span>
      </button>
    </div>
  );
}
