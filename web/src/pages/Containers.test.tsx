/**
 * Tests for the Containers page component.
 * Covers AC-G7: containers list with color-coded health badges and tooltips.
 * Covers AC-G16: restart confirmation modal with active tasks and child teams.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { Containers } from './Containers';

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

import { getContainers, restartContainer } from '@/services/api';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return wrapper;
}

const MOCK_CONTAINERS = [
  {
    slug: 'weather-team',
    health: 'running',
    agentCount: 3,
    uptime: 3661,
    restartCount: 1,
    activeTaskCount: 2,
    childTeams: ['forecast-team'],
  },
  {
    slug: 'code-team',
    health: 'degraded',
    agentCount: 2,
    uptime: 120,
    restartCount: 0,
    activeTaskCount: 0,
    childTeams: [],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Containers page', () => {
  it('renders the page heading', async () => {
    vi.mocked(getContainers).mockResolvedValue({ containers: [] });

    render(<Containers />, { wrapper: makeWrapper() });

    expect(screen.getByText('Containers')).not.toBeNull();
  });

  it('shows loading state initially', () => {
    vi.mocked(getContainers).mockReturnValue(new Promise(() => {}));

    render(<Containers />, { wrapper: makeWrapper() });

    expect(screen.getByText('Loading containers...')).not.toBeNull();
  });

  it('renders containers in a table after loading', async () => {
    vi.mocked(getContainers).mockResolvedValue({ containers: MOCK_CONTAINERS });

    render(<Containers />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('weather-team')).not.toBeNull());
    expect(screen.getByText('code-team')).not.toBeNull();
  });

  it('shows correct container count in header', async () => {
    vi.mocked(getContainers).mockResolvedValue({ containers: MOCK_CONTAINERS });

    render(<Containers />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('2 containers')).not.toBeNull());
  });

  it('shows singular count label for one container', async () => {
    vi.mocked(getContainers).mockResolvedValue({ containers: [MOCK_CONTAINERS[0]] });

    render(<Containers />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('1 container')).not.toBeNull());
  });

  it('shows empty state when no containers', async () => {
    vi.mocked(getContainers).mockResolvedValue({ containers: [] });

    render(<Containers />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('No containers found')).not.toBeNull());
  });

  it('shows error state when fetch fails', async () => {
    vi.mocked(getContainers).mockRejectedValue(new Error('Network error'));

    render(<Containers />, { wrapper: makeWrapper() });

    await waitFor(() =>
      expect(screen.getByText(/Failed to load containers/)).not.toBeNull()
    );
  });

  it('renders health badges for all 7 ContainerHealth states', async () => {
    const allStates = [
      { slug: 'a', health: 'running', agentCount: 1, uptime: 60, restartCount: 0, activeTaskCount: 0, childTeams: [] },
      { slug: 'b', health: 'starting', agentCount: 0, uptime: 5, restartCount: 0, activeTaskCount: 0, childTeams: [] },
      { slug: 'c', health: 'degraded', agentCount: 1, uptime: 120, restartCount: 0, activeTaskCount: 0, childTeams: [] },
      { slug: 'd', health: 'unhealthy', agentCount: 1, uptime: 200, restartCount: 1, activeTaskCount: 0, childTeams: [] },
      { slug: 'e', health: 'unreachable', agentCount: 0, uptime: 500, restartCount: 2, activeTaskCount: 0, childTeams: [] },
      { slug: 'f', health: 'stopping', agentCount: 0, uptime: 300, restartCount: 0, activeTaskCount: 0, childTeams: [] },
      { slug: 'g', health: 'stopped', agentCount: 0, uptime: 400, restartCount: 0, activeTaskCount: 0, childTeams: [] },
    ];
    vi.mocked(getContainers).mockResolvedValue({ containers: allStates });

    render(<Containers />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('Running')).not.toBeNull());
    expect(screen.getByText('Starting')).not.toBeNull();
    expect(screen.getByText('Degraded')).not.toBeNull();
    expect(screen.getByText('Unhealthy')).not.toBeNull();
    expect(screen.getByText('Unreachable')).not.toBeNull();
    expect(screen.getByText('Stopping')).not.toBeNull();
    expect(screen.getByText('Stopped')).not.toBeNull();
  });

  it('renders health badge with tooltip title attribute', async () => {
    vi.mocked(getContainers).mockResolvedValue({
      containers: [{ ...MOCK_CONTAINERS[0], health: 'unhealthy' }],
    });

    render(<Containers />, { wrapper: makeWrapper() });

    await waitFor(() => {
      const badge = screen.getByText('Unhealthy');
      expect(badge.getAttribute('title')).toContain('Missed 3+');
    });
  });

  it('formats uptime in hours and minutes correctly', async () => {
    vi.mocked(getContainers).mockResolvedValue({ containers: MOCK_CONTAINERS });

    render(<Containers />, { wrapper: makeWrapper() });

    // MOCK_CONTAINERS[0].uptime = 3661 => 1h 1m
    await waitFor(() => expect(screen.getByText('1h 1m')).not.toBeNull());
    // MOCK_CONTAINERS[1].uptime = 120 => 2m 0s
    expect(screen.getByText('2m 0s')).not.toBeNull();
  });

  it('renders the required table columns', async () => {
    vi.mocked(getContainers).mockResolvedValue({ containers: [] });

    render(<Containers />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByRole('table')).not.toBeNull());

    expect(screen.getByRole('columnheader', { name: /team slug/i })).not.toBeNull();
    expect(screen.getByRole('columnheader', { name: /health/i })).not.toBeNull();
    expect(screen.getByRole('columnheader', { name: /agents/i })).not.toBeNull();
    expect(screen.getByRole('columnheader', { name: /uptime/i })).not.toBeNull();
    expect(screen.getByRole('columnheader', { name: /restarts/i })).not.toBeNull();
    expect(screen.getByRole('columnheader', { name: /active tasks/i })).not.toBeNull();
    expect(screen.getByRole('columnheader', { name: /actions/i })).not.toBeNull();
  });

  it('renders a Restart button for each container', async () => {
    vi.mocked(getContainers).mockResolvedValue({ containers: MOCK_CONTAINERS });

    render(<Containers />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('weather-team')).not.toBeNull());

    const restartButtons = screen.getAllByRole('button', { name: /restart container/i });
    expect(restartButtons.length).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Modal tests
  // ---------------------------------------------------------------------------

  it('opens restart modal when Restart button is clicked', async () => {
    vi.mocked(getContainers).mockResolvedValue({ containers: MOCK_CONTAINERS });

    render(<Containers />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('weather-team')).not.toBeNull());

    const [firstButton] = screen.getAllByRole('button', { name: /restart container weather-team/i });
    fireEvent.click(firstButton);

    expect(screen.getByRole('dialog')).not.toBeNull();
    expect(screen.getByText(/Restart container "weather-team"/)).not.toBeNull();
  });

  it('modal shows active task count when tasks exist', async () => {
    vi.mocked(getContainers).mockResolvedValue({ containers: MOCK_CONTAINERS });

    render(<Containers />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('weather-team')).not.toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /restart container weather-team/i }));

    // weather-team has activeTaskCount: 2
    expect(screen.getByText(/2 active tasks will be interrupted/)).not.toBeNull();
  });

  it('modal shows "no active tasks" message when activeTaskCount is 0', async () => {
    vi.mocked(getContainers).mockResolvedValue({ containers: MOCK_CONTAINERS });

    render(<Containers />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('code-team')).not.toBeNull());

    // code-team has activeTaskCount: 0
    fireEvent.click(screen.getByRole('button', { name: /restart container code-team/i }));

    expect(screen.getByText(/No active tasks/)).not.toBeNull();
  });

  it('modal lists affected child teams when they exist', async () => {
    vi.mocked(getContainers).mockResolvedValue({ containers: MOCK_CONTAINERS });

    render(<Containers />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('weather-team')).not.toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /restart container weather-team/i }));

    // weather-team has childTeams: ['forecast-team']
    expect(screen.getByText('forecast-team')).not.toBeNull();
  });

  it('modal does not show child teams section when childTeams is empty', async () => {
    vi.mocked(getContainers).mockResolvedValue({ containers: MOCK_CONTAINERS });

    render(<Containers />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('code-team')).not.toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /restart container code-team/i }));

    expect(screen.queryByText(/Child teams that will be affected/)).toBeNull();
  });

  it('closes modal when Cancel is clicked', async () => {
    vi.mocked(getContainers).mockResolvedValue({ containers: MOCK_CONTAINERS });

    render(<Containers />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('weather-team')).not.toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /restart container weather-team/i }));
    expect(screen.getByRole('dialog')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /cancel and close/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes modal when Escape key is pressed', async () => {
    vi.mocked(getContainers).mockResolvedValue({ containers: MOCK_CONTAINERS });

    render(<Containers />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('weather-team')).not.toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /restart container weather-team/i }));
    expect(screen.getByRole('dialog')).not.toBeNull();

    fireEvent.keyDown(screen.getByRole('dialog').parentElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes modal when backdrop is clicked', async () => {
    vi.mocked(getContainers).mockResolvedValue({ containers: MOCK_CONTAINERS });

    render(<Containers />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('weather-team')).not.toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /restart container weather-team/i }));
    const backdrop = screen.getByRole('dialog').parentElement!;
    fireEvent.click(backdrop);

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('calls restartContainer and closes modal on confirm', async () => {
    vi.mocked(getContainers).mockResolvedValue({ containers: MOCK_CONTAINERS });
    vi.mocked(restartContainer).mockResolvedValue({ slug: 'weather-team', status: 'restarting' });

    render(<Containers />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('weather-team')).not.toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /restart container weather-team/i }));
    fireEvent.click(screen.getByRole('button', { name: /^restart$/i }));

    await waitFor(() => {
      expect(vi.mocked(restartContainer)).toHaveBeenCalledWith('weather-team');
    });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Restart button is disabled while restart is in progress', async () => {
    vi.mocked(getContainers).mockResolvedValue({ containers: MOCK_CONTAINERS });
    // Never resolves so mutation stays pending
    vi.mocked(restartContainer).mockReturnValue(new Promise(() => {}));

    render(<Containers />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('weather-team')).not.toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /restart container weather-team/i }));

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /^restart$/i }));
    });

    // While mutation is pending, the confirm button should be disabled
    await waitFor(() => {
      const confirmBtn = screen.getByRole('button', { name: /restarting/i });
      expect(confirmBtn.hasAttribute('disabled')).toBe(true);
    });
  });

  it('modal has aria-modal and aria-labelledby for accessibility', async () => {
    vi.mocked(getContainers).mockResolvedValue({ containers: MOCK_CONTAINERS });

    render(<Containers />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('weather-team')).not.toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /restart container weather-team/i }));

    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('restart-modal-title');
    expect(dialog.getAttribute('aria-describedby')).toBe('restart-modal-desc');
  });
});
