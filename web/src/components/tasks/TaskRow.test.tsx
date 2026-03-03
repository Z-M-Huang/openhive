import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TaskRow } from './TaskRow';
import type { Task } from '../../hooks/useApi';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'tid-task-00000001',
    team_slug: 'alpha',
    status: 'running',
    prompt: 'Do the thing',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('TaskRow', () => {
  it('renders task status badge', () => {
    const task = makeTask();
    render(<TaskRow task={task} onClick={vi.fn()} />);
    expect(screen.getByTestId(`task-status-${task.id}`)).toHaveTextContent('running');
  });

  it('renders team slug', () => {
    const task = makeTask();
    render(<TaskRow task={task} onClick={vi.fn()} />);
    expect(screen.getByText('alpha')).toBeInTheDocument();
  });

  it('renders truncated prompt', () => {
    const task = makeTask();
    render(<TaskRow task={task} onClick={vi.fn()} />);
    expect(screen.getByText('Do the thing')).toBeInTheDocument();
  });

  it('calls onClick when clicked', () => {
    const onClick = vi.fn();
    const task = makeTask();
    render(<TaskRow task={task} onClick={onClick} />);
    fireEvent.click(screen.getByTestId(`task-row-${task.id}`).querySelector('button')!);
    expect(onClick).toHaveBeenCalledWith(task);
  });

  it('shows truncated task ID', () => {
    const task = makeTask({ id: 'tid-task-abcdefgh' });
    render(<TaskRow task={task} onClick={vi.fn()} />);
    // The span renders "..." and the ID suffix as separate text nodes; test via textContent
    const span = screen.getByTestId(`task-row-${task.id}`).querySelector('span');
    expect(span?.textContent).toContain('abcdefgh');
  });

  it('shows completed status with green badge', () => {
    const task = makeTask({ status: 'completed' });
    render(<TaskRow task={task} onClick={vi.fn()} />);
    const badge = screen.getByTestId(`task-status-${task.id}`);
    expect(badge).toHaveTextContent('completed');
    expect(badge.className).toContain('green');
  });

  it('shows failed status with red badge', () => {
    const task = makeTask({ status: 'failed' });
    render(<TaskRow task={task} onClick={vi.fn()} />);
    const badge = screen.getByTestId(`task-status-${task.id}`);
    expect(badge.className).toContain('red');
  });
});
