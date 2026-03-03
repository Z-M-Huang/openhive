import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LogRow } from './LogRow';
import type { LogEntry } from '../../hooks/useApi';

const infoEntry: LogEntry = {
  id: 1,
  level: 'info',
  component: 'orchestrator',
  action: 'task_created',
  message: 'Task was created',
  timestamp: new Date().toISOString(),
};

const entryWithParams: LogEntry = {
  id: 2,
  level: 'error',
  component: 'container',
  action: 'start_failed',
  message: 'Container failed',
  params: { error: 'OOM', container: 'alpha' },
  team_name: 'alpha',
  task_id: 'tid-task-00000001',
  timestamp: new Date().toISOString(),
};

describe('LogRow', () => {
  it('renders the log message', () => {
    render(<LogRow entry={infoEntry} />);
    expect(screen.getByText('Task was created')).toBeInTheDocument();
  });

  it('renders level badge', () => {
    render(<LogRow entry={infoEntry} />);
    expect(screen.getByTestId('log-level')).toHaveTextContent('info');
  });

  it('renders component name', () => {
    render(<LogRow entry={infoEntry} />);
    expect(screen.getByText('orchestrator')).toBeInTheDocument();
  });

  it('starts collapsed (no detail visible)', () => {
    render(<LogRow entry={entryWithParams} />);
    expect(screen.queryByTestId('log-detail')).not.toBeInTheDocument();
  });

  it('expands to show detail on click', () => {
    render(<LogRow entry={entryWithParams} />);
    fireEvent.click(screen.getByTestId('log-row').querySelector('button')!);
    expect(screen.getByTestId('log-detail')).toBeInTheDocument();
  });

  it('shows params as JSON in pre block (XSS-safe)', () => {
    render(<LogRow entry={entryWithParams} />);
    fireEvent.click(screen.getByTestId('log-row').querySelector('button')!);
    const pre = screen.getByTestId('log-params');
    expect(pre.tagName).toBe('PRE');
    expect(pre).toHaveTextContent('OOM');
    expect(pre).toHaveTextContent('alpha');
  });

  it('shows team name when present', () => {
    render(<LogRow entry={entryWithParams} />);
    expect(screen.getByText('alpha')).toBeInTheDocument();
  });
});
