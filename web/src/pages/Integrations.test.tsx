/**
 * Tests for the Integrations page component.
 * Covers AC-G8: lifecycle pipeline visualization, team filter, config_path field,
 * failed/rolled_back terminal state display.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { Integrations } from './Integrations';

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

import { getIntegrations, getTeams } from '@/services/api';

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

const MOCK_TEAMS = {
  teams: [
    { tid: 'tid-weather-aaa', slug: 'weather-team', coordinatorAid: 'aid-beta-abc222', health: 'healthy', agentCount: 2, depth: 1 },
    { tid: 'tid-code-bbb', slug: 'code-team', coordinatorAid: 'aid-beta-abc222', health: 'healthy', agentCount: 1, depth: 1 },
  ],
};

const MOCK_INTEGRATIONS = [
  {
    id: 'integ-001',
    name: 'github-webhook',
    teamSlug: 'weather-team',
    config_path: 'integrations/github.yaml',
    status: 'active' as const,
    error_message: '',
    created_at: 1700000000000,
  },
  {
    id: 'integ-002',
    name: 'slack-notifier',
    teamSlug: 'code-team',
    config_path: 'integrations/slack.yaml',
    status: 'validated' as const,
    error_message: '',
    created_at: 1700000001000,
  },
  {
    id: 'integ-003',
    name: 'jira-sync',
    teamSlug: 'weather-team',
    config_path: 'integrations/jira.yaml',
    status: 'failed' as const,
    error_message: 'Connection refused: could not reach jira.example.com',
    created_at: 1700000002000,
  },
  {
    id: 'integ-004',
    name: 'pagerduty',
    teamSlug: 'code-team',
    config_path: 'integrations/pagerduty.yaml',
    status: 'rolled_back' as const,
    error_message: '',
    created_at: 1700000003000,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getTeams).mockResolvedValue(MOCK_TEAMS);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Integrations page', () => {
  it('renders the page heading', async () => {
    vi.mocked(getIntegrations).mockResolvedValue({ integrations: [] });

    render(<Integrations />, { wrapper: makeWrapper() });

    expect(screen.getByText('Integrations')).not.toBeNull();
  });

  it('shows loading state initially', () => {
    vi.mocked(getIntegrations).mockReturnValue(new Promise(() => {}));

    render(<Integrations />, { wrapper: makeWrapper() });

    expect(screen.getByText('Loading integrations...')).not.toBeNull();
  });

  it('renders integration cards after loading', async () => {
    vi.mocked(getIntegrations).mockResolvedValue({ integrations: MOCK_INTEGRATIONS });

    render(<Integrations />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('github-webhook')).not.toBeNull());
    expect(screen.getByText('slack-notifier')).not.toBeNull();
  });

  it('shows correct integration count in header', async () => {
    vi.mocked(getIntegrations).mockResolvedValue({ integrations: MOCK_INTEGRATIONS });

    render(<Integrations />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('4 integrations')).not.toBeNull());
  });

  it('shows singular count for one integration', async () => {
    vi.mocked(getIntegrations).mockResolvedValue({ integrations: [MOCK_INTEGRATIONS[0]] });

    render(<Integrations />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('1 integration')).not.toBeNull());
  });

  it('shows empty state when no integrations exist', async () => {
    vi.mocked(getIntegrations).mockResolvedValue({ integrations: [] });

    render(<Integrations />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('No integrations found')).not.toBeNull());
  });

  it('shows team-scoped empty state when filter is active', async () => {
    vi.mocked(getIntegrations).mockResolvedValue({ integrations: [] });

    render(<Integrations />, { wrapper: makeWrapper() });

    // Wait for teams to load
    await waitFor(() => {
      const select = screen.getByLabelText('Filter by team') as HTMLSelectElement;
      expect(select.options.length).toBeGreaterThan(1);
    });

    const select = screen.getByLabelText('Filter by team');
    fireEvent.change(select, { target: { value: 'weather-team' } });

    await waitFor(() =>
      expect(screen.getByText(/No integrations for team "weather-team"/)).not.toBeNull()
    );
  });

  it('shows error state when fetch fails', async () => {
    vi.mocked(getIntegrations).mockRejectedValue(new Error('Network error'));

    render(<Integrations />, { wrapper: makeWrapper() });

    await waitFor(() =>
      expect(screen.getByText(/Failed to load integrations/)).not.toBeNull()
    );
  });

  it('displays config_path as a read-only input field', async () => {
    vi.mocked(getIntegrations).mockResolvedValue({ integrations: [MOCK_INTEGRATIONS[0]] });

    render(<Integrations />, { wrapper: makeWrapper() });

    await waitFor(() => {
      const input = screen.getByLabelText('Config path for github-webhook') as HTMLInputElement;
      expect(input.value).toBe('integrations/github.yaml');
      expect(input.readOnly).toBe(true);
    });
  });

  it('displays the teamSlug for each integration', async () => {
    vi.mocked(getIntegrations).mockResolvedValue({ integrations: [MOCK_INTEGRATIONS[0]] });

    render(<Integrations />, { wrapper: makeWrapper() });

    await waitFor(() => {
      // Use getAllByText since 'weather-team' may appear in both the dropdown and the card
      const matches = screen.getAllByText('weather-team');
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Lifecycle pipeline tests
  // ---------------------------------------------------------------------------

  it('renders all 5 pipeline stage labels for an active integration', async () => {
    vi.mocked(getIntegrations).mockResolvedValue({ integrations: [MOCK_INTEGRATIONS[0]] });

    render(<Integrations />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('github-webhook')).not.toBeNull());

    expect(screen.getByText('Proposed')).not.toBeNull();
    expect(screen.getByText('Validated')).not.toBeNull();
    expect(screen.getByText('Tested')).not.toBeNull();
    expect(screen.getByText('Approved')).not.toBeNull();
    expect(screen.getByText('Active')).not.toBeNull();
  });

  it('marks the current stage with aria-current="step"', async () => {
    vi.mocked(getIntegrations).mockResolvedValue({ integrations: [MOCK_INTEGRATIONS[1]] }); // validated

    render(<Integrations />, { wrapper: makeWrapper() });

    await waitFor(() => {
      const current = screen.getByText('Validated');
      expect(current.getAttribute('aria-current')).toBe('step');
    });

    // Other stages should not have aria-current
    expect(screen.getByText('Proposed').getAttribute('aria-current')).toBeNull();
    expect(screen.getByText('Tested').getAttribute('aria-current')).toBeNull();
  });

  it('pipeline is labeled with the lifecycle stage aria-label', async () => {
    vi.mocked(getIntegrations).mockResolvedValue({ integrations: [MOCK_INTEGRATIONS[0]] }); // active

    render(<Integrations />, { wrapper: makeWrapper() });

    await waitFor(() => {
      const pipeline = screen.getByLabelText('Lifecycle stage: active');
      expect(pipeline).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Terminal state tests
  // ---------------------------------------------------------------------------

  it('shows "Failed" badge for integrations with failed status', async () => {
    vi.mocked(getIntegrations).mockResolvedValue({ integrations: [MOCK_INTEGRATIONS[2]] }); // failed

    render(<Integrations />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('Failed')).not.toBeNull());
  });

  it('shows "Rolled back" badge for rolled_back integrations', async () => {
    vi.mocked(getIntegrations).mockResolvedValue({ integrations: [MOCK_INTEGRATIONS[3]] }); // rolled_back

    render(<Integrations />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('Rolled back')).not.toBeNull());
  });

  it('shows error_message for failed integrations that have one', async () => {
    vi.mocked(getIntegrations).mockResolvedValue({ integrations: [MOCK_INTEGRATIONS[2]] }); // failed, has error_message

    render(<Integrations />, { wrapper: makeWrapper() });

    await waitFor(() =>
      expect(screen.getByText(/Connection refused: could not reach jira\.example\.com/)).not.toBeNull()
    );
  });

  it('shows fallback note for terminal state integrations with no error_message', async () => {
    vi.mocked(getIntegrations).mockResolvedValue({ integrations: [MOCK_INTEGRATIONS[3]] }); // rolled_back, no error_message

    render(<Integrations />, { wrapper: makeWrapper() });

    await waitFor(() =>
      expect(screen.getByText(/Integration did not complete the lifecycle pipeline/)).not.toBeNull()
    );
  });

  it('does not show pipeline arrows for failed integrations', async () => {
    vi.mocked(getIntegrations).mockResolvedValue({ integrations: [MOCK_INTEGRATIONS[2]] }); // failed

    render(<Integrations />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('Failed')).not.toBeNull());

    // Pipeline should NOT be rendered for terminal states
    // (aria-label "Lifecycle stage: failed" will not match a pipeline element)
    expect(screen.queryByLabelText('Lifecycle stage: failed')).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Team filter tests
  // ---------------------------------------------------------------------------

  it('renders team filter dropdown with options', async () => {
    vi.mocked(getIntegrations).mockResolvedValue({ integrations: [] });

    render(<Integrations />, { wrapper: makeWrapper() });

    await waitFor(() => {
      const select = screen.getByLabelText('Filter by team') as HTMLSelectElement;
      // "All teams" + 2 team options
      expect(select.options.length).toBe(3);
    });
  });

  it('calls getIntegrations with team filter when team is selected', async () => {
    vi.mocked(getIntegrations).mockResolvedValue({ integrations: [] });

    render(<Integrations />, { wrapper: makeWrapper() });

    await waitFor(() => {
      const select = screen.getByLabelText('Filter by team') as HTMLSelectElement;
      expect(select.options.length).toBeGreaterThan(1);
    });

    const select = screen.getByLabelText('Filter by team');
    fireEvent.change(select, { target: { value: 'weather-team' } });

    await waitFor(() =>
      expect(vi.mocked(getIntegrations)).toHaveBeenCalledWith({ team: 'weather-team' })
    );
  });

  it('shows Clear button when a team filter is active', async () => {
    vi.mocked(getIntegrations).mockResolvedValue({ integrations: [] });

    render(<Integrations />, { wrapper: makeWrapper() });

    await waitFor(() => {
      const select = screen.getByLabelText('Filter by team') as HTMLSelectElement;
      expect(select.options.length).toBeGreaterThan(1);
    });

    expect(screen.queryByText('Clear')).toBeNull();

    const select = screen.getByLabelText('Filter by team');
    fireEvent.change(select, { target: { value: 'weather-team' } });

    expect(screen.getByText('Clear')).not.toBeNull();
  });

  it('clears the team filter when Clear is clicked', async () => {
    vi.mocked(getIntegrations).mockResolvedValue({ integrations: [] });

    render(<Integrations />, { wrapper: makeWrapper() });

    await waitFor(() => {
      const select = screen.getByLabelText('Filter by team') as HTMLSelectElement;
      expect(select.options.length).toBeGreaterThan(1);
    });

    const select = screen.getByLabelText('Filter by team') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'weather-team' } });

    fireEvent.click(screen.getByText('Clear'));

    expect(select.value).toBe('');
    expect(screen.queryByText('Clear')).toBeNull();
  });
});
