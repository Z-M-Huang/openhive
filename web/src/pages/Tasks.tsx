import { useState, useCallback, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useTasks, useTask, useCancelTask } from '../hooks/useApi';
import type { Task } from '../hooks/useApi';
import { TaskRow } from '../components/tasks/TaskRow';
import { TaskTree } from '../components/tasks/TaskTree';
import { useWebSocket } from '../hooks/useWebSocket';
import { queryClient } from '../lib/queryClient';
import type { WSMessage } from '../hooks/useWebSocket';

/**
 * Task monitoring page with virtual scroll, real-time updates, and task detail panel.
 */
export function Tasks(): React.JSX.Element {
  const [statusFilter, setStatusFilter] = useState('running');
  const [teamFilter, setTeamFilter] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const { data, isLoading, isError } = useTasks({
    status: statusFilter || undefined,
    team: teamFilter || undefined,
    limit: 100,
  });

  const tasks = data?.tasks ?? [];

  // Real-time task updates
  const handleMessage = useCallback((msg: WSMessage): void => {
    const type = msg.type as string;
    if (
      type === 'task_created' ||
      type === 'task_updated' ||
      type === 'task_completed' ||
      type === 'task_failed' ||
      type === 'task_cancelled'
    ) {
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
    }
  }, []);

  useWebSocket({ onMessage: handleMessage });

  // Virtual scrolling
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: tasks.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48,
    overscan: 5,
  });

  const handleTaskClick = (task: Task): void => {
    setSelectedTaskId(task.id === selectedTaskId ? null : task.id);
  };

  return (
    <div data-testid="tasks-page" className="flex flex-col h-full">
      <h1 className="text-2xl font-bold mb-4">Tasks</h1>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-4" data-testid="task-filters">
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          aria-label="Filter by status"
          data-testid="task-status-filter"
        >
          <option value="">All statuses</option>
          <option value="pending">pending</option>
          <option value="running">running</option>
          <option value="completed">completed</option>
          <option value="failed">failed</option>
          <option value="cancelled">cancelled</option>
        </select>

        <input
          type="text"
          placeholder="Team..."
          value={teamFilter}
          onChange={e => setTeamFilter(e.target.value)}
          className="rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          aria-label="Filter by team"
          data-testid="task-team-filter"
        />
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading tasks...</p>}
      {isError && <p className="text-sm text-destructive">Error loading tasks</p>}

      {!isLoading && !isError && (
        <p className="text-xs text-muted-foreground mb-2">{data?.total ?? 0} tasks total</p>
      )}

      <div className="flex flex-1 gap-4 min-h-0">
        {/* Task list */}
        <div
          ref={parentRef}
          className="flex-1 overflow-auto rounded-lg border border-border bg-card"
          data-testid="task-table"
          style={{ minHeight: 0 }}
        >
          {tasks.length === 0 && !isLoading ? (
            <p className="p-4 text-sm text-muted-foreground">No tasks found.</p>
          ) : (
            <div
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                width: '100%',
                position: 'relative',
              }}
            >
              {virtualizer.getVirtualItems().map(virtualItem => {
                const task = tasks[virtualItem.index];
                return (
                  <div
                    key={virtualItem.key}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: `${virtualItem.size}px`,
                      transform: `translateY(${virtualItem.start}px)`,
                    }}
                  >
                    <TaskRow
                      task={task}
                      onClick={handleTaskClick}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Task detail panel */}
        {selectedTaskId && (
          <TaskDetailPanel
            taskId={selectedTaskId}
            onClose={() => setSelectedTaskId(null)}
          />
        )}
      </div>
    </div>
  );
}

interface TaskDetailPanelProps {
  taskId: string;
  onClose: () => void;
}

function TaskDetailPanel({ taskId, onClose }: TaskDetailPanelProps): React.JSX.Element {
  const { data: taskDetail, isLoading } = useTask(taskId);
  const cancelTask = useCancelTask();
  const [confirmCancel, setConfirmCancel] = useState(false);

  const handleCancel = (): void => {
    if (!confirmCancel) {
      setConfirmCancel(true);
      return;
    }
    void cancelTask.mutate(taskId, {
      onSuccess: () => setConfirmCancel(false),
    });
  };

  return (
    <div
      className="w-80 shrink-0 rounded-lg border border-border bg-card p-4 overflow-auto"
      data-testid="task-detail"
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-medium text-sm">Task Detail</h3>
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground text-lg leading-none"
          aria-label="Close detail panel"
        >
          &times;
        </button>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}

      {taskDetail && (
        <div className="space-y-3">
          <div>
            <p className="text-xs text-muted-foreground">ID</p>
            <p className="text-sm font-mono break-all">{taskDetail.id}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Status</p>
            <p className="text-sm font-medium">{taskDetail.status}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Team</p>
            <p className="text-sm">{taskDetail.team_slug}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Prompt</p>
            <p className="text-sm">{taskDetail.prompt}</p>
          </div>

          {/* Subtask tree */}
          {taskDetail.subtasks && taskDetail.subtasks.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground mb-1">Subtasks</p>
              <TaskTree
                tasks={taskDetail.subtasks}
                rootId={taskDetail.id}
              />
            </div>
          )}

          {/* Cancel button — only for pending/running tasks */}
          {(taskDetail.status === 'pending' || taskDetail.status === 'running') && (
            <div>
              {cancelTask.isError && (
                <p className="text-xs text-destructive mb-1">Failed to cancel</p>
              )}
              <button
                type="button"
                onClick={handleCancel}
                disabled={cancelTask.isPending}
                className="text-sm text-destructive hover:underline disabled:opacity-50"
                data-testid="cancel-task-btn"
              >
                {confirmCancel
                  ? 'Confirm cancel?'
                  : cancelTask.isPending
                    ? 'Cancelling...'
                    : 'Cancel task'}
              </button>
              {confirmCancel && (
                <button
                  type="button"
                  onClick={() => setConfirmCancel(false)}
                  className="text-sm text-muted-foreground hover:underline ml-2"
                >
                  Never mind
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
