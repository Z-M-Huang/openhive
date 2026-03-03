import type { Task } from '../../hooks/useApi';
import { cn } from '../../lib/utils';

interface TaskTreeProps {
  tasks: Task[];
  rootId: string;
  depth?: number;
}

const statusColors: Record<string, string> = {
  pending: 'bg-gray-400',
  running: 'bg-blue-500',
  completed: 'bg-green-500',
  failed: 'bg-red-500',
  cancelled: 'bg-yellow-500',
};

/**
 * Recursive subtask tree visualization.
 */
export function TaskTree({ tasks, rootId, depth = 0 }: TaskTreeProps): React.JSX.Element {
  const children = tasks.filter(t => t.parent_id === rootId);

  if (children.length === 0) return <></>;

  return (
    <div
      className={cn('border-l border-border pl-4 space-y-1', depth === 0 && 'mt-2')}
      data-testid={`task-tree-${rootId}`}
    >
      {children.map(task => (
        <div key={task.id} data-testid={`task-subtree-node-${task.id}`}>
          <div className="flex items-center gap-2 py-1">
            <span
              className={cn(
                'h-2 w-2 rounded-full shrink-0',
                statusColors[task.status] ?? 'bg-gray-400',
              )}
              aria-label={`Task status: ${task.status}`}
            />
            <span className="text-xs font-mono text-muted-foreground">
              ...{task.id.slice(-8)}
            </span>
            <span className="text-xs text-muted-foreground">{task.status}</span>
            <span className="text-sm truncate flex-1">{task.prompt}</span>
            <span className="text-xs text-muted-foreground">{task.team_slug}</span>
          </div>
          <TaskTree tasks={tasks} rootId={task.id} depth={depth + 1} />
        </div>
      ))}
    </div>
  );
}
