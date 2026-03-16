/**
 * Tests for the Agents page component.
 * Covers AC-G6: agents table with team filter, sortable columns, real-time WS status.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { Agents } from './Agents';

// ---------------------------------------------------------------------------
// Mock api module
// ---------------------------------------------------------------------------

vi.mock('@/services/api', () => ({
  getHealth: vi.fn(),
  getTeams: vi.fn(),
  getTeam: vi.fn(),
  createTeam: vi.fn(),
  deleteTeam: vi.fn(),
  getTasks: vi.fn(),
  getTask: vi.fn(),
  getTaskEvents: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  getLogs: vi.fn(),
  getWebhooks: vi.fn(),
  deleteWebhook: vi.fn(),
  getAgents: vi.fn(),
  getContainers: vi.fn(),
  restartContainer: vi.fn(),
  getIntegrations: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  reloadConfig: vi.fn(),
}));

import { getAgents, getTeams } from '@/services/api';

// ---------------------------------------------------------------------------
// Mock usePortalWS - capture the onEvent callback for manual invocation
// ---------------------------------------------------------------------------

type PortalWSOptions = {
  onEvent?: (event: { type: string; data: Record<string, unknown>; timestamp: number }) => void;
};

let capturedOnEvent: PortalWSOptions['onEvent'] | undefined;

vi.mock('@/hooks/usePortalWS', () => ({
  usePortalWS: (opts: PortalWSOptions = {}) => {
    capturedOnEvent = opts.onEvent;
    return { isConnected: true, lastEvent: null, send: vi.fn(), reconnect: vi.fn() };
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
    },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return wrapper;
}

const MOCK_AGENTS = [
  {
    aid: 'aid-alpha-abc111',
    name: 'alpha',
    teamSlug: 'weather-team',
    role: 'member',
    status: 'idle',
    leadsTeam: false,
    modelTier: 'haiku',
  },
  {
    aid: 'aid-beta-abc222',
    name: 'beta',
    teamSlug: 'code-team',
    role: 'lead',
    status: 'active',
    leadsTeam: true,
    modelTier: 'sonnet',
  },
  {
    aid: 'aid-gamma-abc333',
    name: 'gamma',
    teamSlug: 'weather-team',
    role: 'member',
    status: 'busy',
    leadsTeam: false,
    modelTier: 'haiku',
  },
];

const MOCK_TEAMS = {
  teams: [
    { tid: 'tid-weather-aaa', slug: 'weather-team', leaderAid: 'aid-beta-abc222', health: 'healthy', agentCount: 2, depth: 1 },
    { tid: 'tid-code-bbb', slug: 'code-team', leaderAid: 'aid-beta-abc222', health: 'healthy', agentCount: 1, depth: 1 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  capturedOnEvent = undefined;
  vi.mocked(getTeams).mockResolvedValue(MOCK_TEAMS);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Agents page', () => {
  it('renders the page heading', async () => {
    vi.mocked(getAgents).mockResolvedValue({ agents: [] });

    render(<Agents />, { wrapper: makeWrapper() });

    expect(screen.getByText('Agents')).not.toBeNull();
  });

  it('shows loading state initially', () => {
    // Never resolves during this test
    vi.mocked(getAgents).mockReturnValue(new Promise(() => {}));

    render(<Agents />, { wrapper: makeWrapper() });

    expect(screen.getByText('Loading agents...')).not.toBeNull();
  });

  it('renders agents in a table after loading', async () => {
    vi.mocked(getAgents).mockResolvedValue({ agents: MOCK_AGENTS });

    render(<Agents />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('alpha')).not.toBeNull());

    expect(screen.getByText('beta')).not.toBeNull();
    expect(screen.getByText('gamma')).not.toBeNull();
  });

  it('displays agent AID in the table', async () => {
    vi.mocked(getAgents).mockResolvedValue({ agents: MOCK_AGENTS });

    render(<Agents />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('aid-alpha-abc111')).not.toBeNull());
  });

  it('shows correct agent count in header', async () => {
    vi.mocked(getAgents).mockResolvedValue({ agents: MOCK_AGENTS });

    render(<Agents />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('3 agents')).not.toBeNull());
  });

  it('renders status badges for each agent', async () => {
    vi.mocked(getAgents).mockResolvedValue({ agents: MOCK_AGENTS });

    render(<Agents />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('idle')).not.toBeNull());
    expect(screen.getByText('active')).not.toBeNull();
    expect(screen.getByText('busy')).not.toBeNull();
  });

  it('marks lead agents with (lead) label', async () => {
    vi.mocked(getAgents).mockResolvedValue({ agents: MOCK_AGENTS });

    render(<Agents />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('(lead)')).not.toBeNull());
  });

  it('shows empty state message when no agents', async () => {
    vi.mocked(getAgents).mockResolvedValue({ agents: [] });

    render(<Agents />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('No agents found')).not.toBeNull());
  });

  it('renders team filter dropdown with team options', async () => {
    vi.mocked(getAgents).mockResolvedValue({ agents: MOCK_AGENTS });

    render(<Agents />, { wrapper: makeWrapper() });

    // Wait for teams to load so options are populated
    await waitFor(() => {
      const select = screen.getByLabelText('Filter by team') as HTMLSelectElement;
      // "All teams" + 2 team options
      expect(select.options.length).toBe(3);
    });
  });

  it('calls getAgents with team filter when team is selected', async () => {
    vi.mocked(getAgents).mockResolvedValue({ agents: MOCK_AGENTS });

    render(<Agents />, { wrapper: makeWrapper() });

    // Wait for agents to load first
    await waitFor(() => expect(screen.getByText('alpha')).not.toBeNull());

    // Simulate selecting a team
    const select = screen.getByLabelText('Filter by team');
    fireEvent.change(select, { target: { value: 'weather-team' } });

    await waitFor(() =>
      expect(vi.mocked(getAgents)).toHaveBeenCalledWith({ team: 'weather-team' })
    );
  });

  it('clears team filter when Clear button is clicked', async () => {
    vi.mocked(getAgents).mockResolvedValue({ agents: MOCK_AGENTS });

    render(<Agents />, { wrapper: makeWrapper() });

    // Wait for agents to load
    await waitFor(() => expect(screen.getByText('alpha')).not.toBeNull());

    const select = screen.getByLabelText('Filter by team') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'weather-team' } });

    // Clear button appears after selecting a team
    await waitFor(() => expect(screen.getByText('Clear')).not.toBeNull());
    fireEvent.click(screen.getByText('Clear'));

    expect(select.value).toBe('');
  });

  it('sorts agents by name ascending by default', async () => {
    vi.mocked(getAgents).mockResolvedValue({ agents: MOCK_AGENTS });

    render(<Agents />, { wrapper: makeWrapper() });

    // Wait for agents to load (data rows appear)
    await waitFor(() => expect(screen.getByText('alpha')).not.toBeNull());

    const rows = screen.getAllByRole('row').slice(1); // skip header row
    const names = rows.map((r) => r.cells[0].textContent);
    expect(names).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('reverses sort direction when the same column header is clicked twice', async () => {
    vi.mocked(getAgents).mockResolvedValue({ agents: MOCK_AGENTS });

    render(<Agents />, { wrapper: makeWrapper() });

    // Wait for agents to load
    await waitFor(() => expect(screen.getByText('alpha')).not.toBeNull());

    // Click Name column header — already asc, clicking again makes it desc
    const nameHeader = screen.getByRole('columnheader', { name: /name/i });
    fireEvent.click(nameHeader);

    await waitFor(() => {
      const rows = screen.getAllByRole('row').slice(1);
      const names = rows.map((r) => r.cells[0].textContent);
      expect(names).toEqual(['gamma', 'beta', 'alpha']);
    });
  });

  it('sorts by a different column when that column header is clicked', async () => {
    vi.mocked(getAgents).mockResolvedValue({ agents: MOCK_AGENTS });

    render(<Agents />, { wrapper: makeWrapper() });

    // Wait for agents to load
    await waitFor(() => expect(screen.getByText('alpha')).not.toBeNull());

    // Click Model Tier column header
    const modelHeader = screen.getByRole('columnheader', { name: /model tier/i });
    fireEvent.click(modelHeader);

    await waitFor(() => {
      const rows = screen.getAllByRole('row').slice(1);
      // haiku < sonnet alphabetically
      const tiers = rows.map((r) => r.cells[5].textContent);
      expect(tiers[0]).toBe('haiku');
      expect(tiers[tiers.length - 1]).toBe('sonnet');
    });
  });

  it('updates agent status in real-time from WS heartbeat', async () => {
    vi.mocked(getAgents).mockResolvedValue({ agents: MOCK_AGENTS });

    render(<Agents />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('idle')).not.toBeNull());

    // Fire a WS heartbeat event that changes alpha's status to 'error'
    expect(capturedOnEvent).toBeDefined();
    act(() => {
      capturedOnEvent!({
        type: 'heartbeat',
        data: {
          agents: [{ aid: 'aid-alpha-abc111', status: 'error' }],
        },
        timestamp: Date.now(),
      });
    });

    await waitFor(() => expect(screen.getByText('error')).not.toBeNull());
    // Original 'idle' badge should no longer show for this agent
    expect(screen.queryByText('idle')).toBeNull();
  });

  it('ignores WS events that are not heartbeats', async () => {
    vi.mocked(getAgents).mockResolvedValue({ agents: MOCK_AGENTS });

    render(<Agents />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('idle')).not.toBeNull());

    act(() => {
      capturedOnEvent!({
        type: 'log_event',
        data: {
          agents: [{ aid: 'aid-alpha-abc111', status: 'error' }],
        },
        timestamp: Date.now(),
      });
    });

    // Status should remain unchanged
    expect(screen.getByText('idle')).not.toBeNull();
  });

  it('shows error state when agent fetch fails', async () => {
    vi.mocked(getAgents).mockRejectedValue(new Error('Network error'));

    render(<Agents />, { wrapper: makeWrapper() });

    await waitFor(() =>
      expect(screen.getByText(/Failed to load agents/)).not.toBeNull()
    );
  });

  it('renders the agents table with all required columns', async () => {
    vi.mocked(getAgents).mockResolvedValue({ agents: [] });

    render(<Agents />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByRole('table')).not.toBeNull());

    expect(screen.getByRole('columnheader', { name: /name/i })).not.toBeNull();
    expect(screen.getByRole('columnheader', { name: /aid/i })).not.toBeNull();
    expect(screen.getByRole('columnheader', { name: /team/i })).not.toBeNull();
    expect(screen.getByRole('columnheader', { name: /role/i })).not.toBeNull();
    expect(screen.getByRole('columnheader', { name: /status/i })).not.toBeNull();
    expect(screen.getByRole('columnheader', { name: /model tier/i })).not.toBeNull();
  });
});
