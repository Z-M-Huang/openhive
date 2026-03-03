import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentBadge } from './AgentBadge';

describe('AgentBadge', () => {
  it('renders agent name', () => {
    render(
      <AgentBadge aid="aid-lead-00000001" name="Lead Agent" />,
    );
    expect(screen.getByText('Lead Agent')).toBeInTheDocument();
  });

  it('renders AID', () => {
    render(
      <AgentBadge aid="aid-lead-00000001" name="Lead Agent" />,
    );
    expect(screen.getByText('aid-lead-00000001')).toBeInTheDocument();
  });

  it('shows stopped status dot by default (no heartbeat)', () => {
    render(
      <AgentBadge aid="aid-lead-00000001" name="Lead" />,
    );
    const dot = screen.getByTestId('agent-status-aid-lead-00000001');
    expect(dot).toHaveAttribute('aria-label', 'Agent status: stopped');
  });

  it('shows idle status dot with green class', () => {
    render(
      <AgentBadge
        aid="aid-lead-00000001"
        name="Lead"
        heartbeat={{ aid: 'aid-lead-00000001', status: 'idle' }}
      />,
    );
    const dot = screen.getByTestId('agent-status-aid-lead-00000001');
    expect(dot).toHaveAttribute('aria-label', 'Agent status: idle');
    expect(dot.className).toContain('green');
  });

  it('shows error status dot with red class', () => {
    render(
      <AgentBadge
        aid="aid-lead-00000001"
        name="Lead"
        heartbeat={{ aid: 'aid-lead-00000001', status: 'error' }}
      />,
    );
    const dot = screen.getByTestId('agent-status-aid-lead-00000001');
    expect(dot.className).toContain('red');
  });

  it('shows busy status dot with yellow class', () => {
    render(
      <AgentBadge
        aid="aid-lead-00000001"
        name="Lead"
        heartbeat={{ aid: 'aid-lead-00000001', status: 'busy' }}
      />,
    );
    const dot = screen.getByTestId('agent-status-aid-lead-00000001');
    expect(dot.className).toContain('yellow');
  });
});
