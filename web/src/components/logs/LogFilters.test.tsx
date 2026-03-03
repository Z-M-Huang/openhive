import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LogFilters } from './LogFilters';

describe('LogFilters', () => {
  it('renders level filter select', () => {
    render(
      <LogFilters
        filters={{}}
        onFiltersChange={vi.fn()}
        includeDebug={false}
        onToggleDebug={vi.fn()}
      />,
    );
    expect(screen.getByTestId('log-level-filter')).toBeInTheDocument();
  });

  it('renders component filter input', () => {
    render(
      <LogFilters
        filters={{}}
        onFiltersChange={vi.fn()}
        includeDebug={false}
        onToggleDebug={vi.fn()}
      />,
    );
    expect(screen.getByTestId('log-component-filter')).toBeInTheDocument();
  });

  it('renders team filter input', () => {
    render(
      <LogFilters
        filters={{}}
        onFiltersChange={vi.fn()}
        includeDebug={false}
        onToggleDebug={vi.fn()}
      />,
    );
    expect(screen.getByTestId('log-team-filter')).toBeInTheDocument();
  });

  it('renders debug toggle checkbox', () => {
    render(
      <LogFilters
        filters={{}}
        onFiltersChange={vi.fn()}
        includeDebug={false}
        onToggleDebug={vi.fn()}
      />,
    );
    expect(screen.getByTestId('debug-toggle')).toBeInTheDocument();
  });

  it('calls onFiltersChange when level changes', () => {
    const onFiltersChange = vi.fn();
    render(
      <LogFilters
        filters={{}}
        onFiltersChange={onFiltersChange}
        includeDebug={false}
        onToggleDebug={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId('log-level-filter'), {
      target: { value: 'error' },
    });
    expect(onFiltersChange).toHaveBeenCalledWith(expect.objectContaining({ level: 'error' }));
  });

  it('calls onToggleDebug when debug checkbox changes', () => {
    const onToggleDebug = vi.fn();
    render(
      <LogFilters
        filters={{}}
        onFiltersChange={vi.fn()}
        includeDebug={false}
        onToggleDebug={onToggleDebug}
      />,
    );
    fireEvent.click(screen.getByTestId('debug-toggle'));
    expect(onToggleDebug).toHaveBeenCalledWith(true);
  });

  it('reflects current filter values', () => {
    render(
      <LogFilters
        filters={{ level: 'warn', component: 'container', team: 'alpha' }}
        onFiltersChange={vi.fn()}
        includeDebug={true}
        onToggleDebug={vi.fn()}
      />,
    );
    expect(screen.getByTestId('log-level-filter')).toHaveValue('warn');
    expect(screen.getByTestId('log-component-filter')).toHaveValue('container');
    expect(screen.getByTestId('log-team-filter')).toHaveValue('alpha');
    expect(screen.getByTestId('debug-toggle')).toBeChecked();
  });
});
