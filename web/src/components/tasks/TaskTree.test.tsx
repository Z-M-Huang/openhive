import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TaskTree } from './TaskTree';
import type { Task } from '../../hooks/useApi';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'tid-task-00000001',
    team_slug: 'alpha',
    status: 'running',
    prompt: 'Root task',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

const rootTask = makeTask({ id: 'tid-task-root0001' });
const child1 = makeTask({
  id: 'tid-task-child001',
  parent_id: 'tid-task-root0001',
  status: 'completed',
  prompt: 'Child task one',
});
const child2 = makeTask({
  id: 'tid-task-child002',
  parent_id: 'tid-task-root0001',
  status: 'failed',
  prompt: 'Child task two',
});
const grandchild = makeTask({
  id: 'tid-task-grand001',
  parent_id: 'tid-task-child001',
  status: 'pending',
  prompt: 'Grandchild task',
});

describe('TaskTree', () => {
  it('renders nothing when root has no children', () => {
    const { container } = render(<TaskTree tasks={[rootTask]} rootId={rootTask.id} />);
    expect(container.firstChild).toBeFalsy();
  });

  it('renders direct children of root', () => {
    render(<TaskTree tasks={[rootTask, child1, child2]} rootId={rootTask.id} />);
    expect(screen.getByTestId('task-subtree-node-tid-task-child001')).toBeInTheDocument();
    expect(screen.getByTestId('task-subtree-node-tid-task-child002')).toBeInTheDocument();
  });

  it('renders child prompts', () => {
    render(<TaskTree tasks={[rootTask, child1, child2]} rootId={rootTask.id} />);
    expect(screen.getByText('Child task one')).toBeInTheDocument();
    expect(screen.getByText('Child task two')).toBeInTheDocument();
  });

  it('renders tree container with correct data-testid', () => {
    render(<TaskTree tasks={[rootTask, child1]} rootId={rootTask.id} />);
    expect(screen.getByTestId('task-tree-tid-task-root0001')).toBeInTheDocument();
  });

  it('renders grandchildren recursively', () => {
    const tasks = [rootTask, child1, grandchild];
    render(<TaskTree tasks={tasks} rootId={rootTask.id} />);
    expect(screen.getByTestId('task-subtree-node-tid-task-grand001')).toBeInTheDocument();
    expect(screen.getByText('Grandchild task')).toBeInTheDocument();
  });

  it('shows status dot with aria-label', () => {
    render(<TaskTree tasks={[rootTask, child1]} rootId={rootTask.id} />);
    expect(screen.getByLabelText('Task status: completed')).toBeInTheDocument();
  });

  it('shows truncated task ID', () => {
    render(<TaskTree tasks={[rootTask, child1]} rootId={rootTask.id} />);
    expect(screen.getByText('...child001')).toBeInTheDocument();
  });
});
