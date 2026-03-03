import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TeamNode } from './TeamNode';
import type { Team } from '../../hooks/useApi';

const alphaTeam: Team = {
  slug: 'alpha',
  tid: 'tid-alpha-00000001',
  leader_aid: 'aid-lead-00000001',
  container_state: 'running',
  agents: [
    { aid: 'aid-lead-00000001', name: 'Lead' },
    { aid: 'aid-agent-00000001', name: 'Agent One' },
  ],
  children: ['beta'],
};

const betaTeam: Team = {
  slug: 'beta',
  tid: 'tid-beta-00000001',
  leader_aid: 'aid-lead-00000002',
  parent_slug: 'alpha',
  container_state: 'stopped',
  agents: [],
  children: [],
};

const teamsMap: Record<string, Team> = {
  alpha: alphaTeam,
  beta: betaTeam,
};

describe('TeamNode', () => {
  it('renders team slug', () => {
    render(<TeamNode team={alphaTeam} teamsMap={teamsMap} />);
    expect(screen.getByTestId('team-node-alpha')).toBeInTheDocument();
    expect(screen.getByText('alpha')).toBeInTheDocument();
  });

  it('shows container state dot', () => {
    render(<TeamNode team={alphaTeam} teamsMap={teamsMap} />);
    const dot = screen.getByTestId('team-state-alpha');
    expect(dot).toHaveAttribute('aria-label', 'Container: running');
    expect(dot.className).toContain('green');
  });

  it('shows stopped state dot for stopped container', () => {
    render(<TeamNode team={betaTeam} teamsMap={teamsMap} />);
    const dot = screen.getByTestId('team-state-beta');
    expect(dot).toHaveAttribute('aria-label', 'Container: stopped');
    expect(dot.className).toContain('gray');
  });

  it('shows agent count', () => {
    render(<TeamNode team={alphaTeam} teamsMap={teamsMap} />);
    expect(screen.getByText('2 agents')).toBeInTheDocument();
  });

  it('renders child teams when expanded (depth=0 starts expanded)', () => {
    render(<TeamNode team={alphaTeam} teamsMap={teamsMap} depth={0} />);
    expect(screen.getByTestId('team-node-beta')).toBeInTheDocument();
  });

  it('shows agents on toggle', () => {
    render(<TeamNode team={alphaTeam} teamsMap={teamsMap} />);
    const toggle = screen.getByTestId('team-agents-toggle-alpha');
    fireEvent.click(toggle);
    expect(screen.getByTestId('team-agents-alpha')).toBeInTheDocument();
    expect(screen.getByTestId('agent-badge-aid-lead-00000001')).toBeInTheDocument();
  });

  it('hides agents on second toggle click', () => {
    render(<TeamNode team={alphaTeam} teamsMap={teamsMap} />);
    const toggle = screen.getByTestId('team-agents-toggle-alpha');
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(screen.queryByTestId('team-agents-alpha')).not.toBeInTheDocument();
  });
});
