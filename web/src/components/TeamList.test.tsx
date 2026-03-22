/**
 * Tests for the TeamList component (AC-G10).
 *
 * Covers:
 * - Default tree view rendering
 * - Hierarchical nesting up to 3 levels (CON-01)
 * - Tree node content: slug, health badge, agent count, coordinator AID
 * - Expandable/collapsible nodes
 * - Inline team info on expand
 * - CSS indentation pattern
 * - Loading / error / empty states
 * - parentSlug-based tree construction
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { TeamList } from './TeamList';

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

import { getTeams, getAgents } from '@/services/api';

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

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_ROOT_TEAMS = [
  {
    tid: 'tid-weather-aaa',
    slug: 'weather-team',
    coordinatorAid: 'aid-lead-weather-abc1',
    health: 'running',
    agentCount: 3,
    depth: 1,
    parentSlug: undefined,
  },
  {
    tid: 'tid-code-bbb',
    slug: 'code-team',
    coordinatorAid: 'aid-lead-code-abc2',
    health: 'degraded',
    agentCount: 2,
    depth: 1,
    parentSlug: undefined,
  },
];

const MOCK_NESTED_TEAMS = [
  {
    tid: 'tid-weather-aaa',
    slug: 'weather-team',
    coordinatorAid: 'aid-lead-weather-abc1',
    health: 'running',
    agentCount: 3,
    depth: 1,
    parentSlug: undefined,
  },
  {
    tid: 'tid-forecast-ccc',
    slug: 'forecast-team',
    coordinatorAid: 'aid-lead-forecast-abc3',
    health: 'starting',
    agentCount: 1,
    depth: 2,
    parentSlug: 'weather-team',
  },
];

const MOCK_THREE_LEVEL_TEAMS = [
  {
    tid: 'tid-root-aaa',
    slug: 'root-team',
    coordinatorAid: 'aid-root-abc1',
    health: 'running',
    agentCount: 2,
    depth: 1,
    parentSlug: undefined,
  },
  {
    tid: 'tid-mid-bbb',
    slug: 'mid-team',
    coordinatorAid: 'aid-mid-abc2',
    health: 'running',
    agentCount: 2,
    depth: 2,
    parentSlug: 'root-team',
  },
  {
    tid: 'tid-leaf-ccc',
    slug: 'leaf-team',
    coordinatorAid: 'aid-leaf-abc3',
    health: 'stopped',
    agentCount: 1,
    depth: 3,
    parentSlug: 'mid-team',
  },
];

// Default mock agents for teams used in expand/collapse tests
const MOCK_WEATHER_AGENTS = {
  agents: [
    { aid: 'aid-lead-weather-abc1', name: 'lead', teamSlug: 'weather-team', role: 'lead', status: 'idle', leadsTeam: 'tid-weather-aaa', modelTier: null },
    { aid: 'aid-member-weather-1', name: 'analyst', teamSlug: 'weather-team', role: 'member', status: 'idle', leadsTeam: null, modelTier: null },
    { aid: 'aid-member-weather-2', name: 'reporter', teamSlug: 'weather-team', role: 'member', status: 'running', leadsTeam: null, modelTier: null },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: getAgents returns empty list (overridden per-test where needed)
  vi.mocked(getAgents).mockResolvedValue({ agents: [] });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TeamList', () => {
  // Loading / error / empty states
  describe('states', () => {
    it('shows loading state while teams are being fetched', () => {
      vi.mocked(getTeams).mockReturnValue(new Promise(() => {}));

      render(<TeamList />, { wrapper: makeWrapper() });

      expect(screen.getByText('Loading teams...')).not.toBeNull();
    });

    it('shows error state when fetch fails', async () => {
      vi.mocked(getTeams).mockRejectedValue(new Error('Network error'));

      render(<TeamList />, { wrapper: makeWrapper() });

      await waitFor(() =>
        expect(screen.getByText('Failed to load teams')).not.toBeNull()
      );
    });

    it('shows empty state when no teams exist', async () => {
      vi.mocked(getTeams).mockResolvedValue({ teams: [] });

      render(<TeamList />, { wrapper: makeWrapper() });

      await waitFor(() =>
        expect(screen.getByText('No teams configured')).not.toBeNull()
      );
    });
  });

  // Basic rendering
  describe('tree rendering', () => {
    it('renders a tree container with role="tree"', async () => {
      vi.mocked(getTeams).mockResolvedValue({ teams: MOCK_ROOT_TEAMS });

      render(<TeamList />, { wrapper: makeWrapper() });

      await waitFor(() => expect(screen.getByRole('tree')).not.toBeNull());
    });

    it('renders all top-level team slugs as tree items', async () => {
      vi.mocked(getTeams).mockResolvedValue({ teams: MOCK_ROOT_TEAMS });

      render(<TeamList />, { wrapper: makeWrapper() });

      await waitFor(() => {
        expect(screen.getByText('weather-team')).not.toBeNull();
        expect(screen.getByText('code-team')).not.toBeNull();
      });
    });

    it('shows the team count in the header', async () => {
      vi.mocked(getTeams).mockResolvedValue({ teams: MOCK_ROOT_TEAMS });

      render(<TeamList />, { wrapper: makeWrapper() });

      await waitFor(() => expect(screen.getByText('Teams (2)')).not.toBeNull());
    });

    it('renders health badge for each team', async () => {
      vi.mocked(getTeams).mockResolvedValue({ teams: MOCK_ROOT_TEAMS });

      render(<TeamList />, { wrapper: makeWrapper() });

      await waitFor(() => {
        expect(screen.getByText('running')).not.toBeNull();
        expect(screen.getByText('degraded')).not.toBeNull();
      });
    });

    it('renders agent count for each team', async () => {
      vi.mocked(getTeams).mockResolvedValue({ teams: MOCK_ROOT_TEAMS });

      render(<TeamList />, { wrapper: makeWrapper() });

      await waitFor(() => {
        // weather-team: 3, code-team: 2
        const agentCounts = screen.getAllByLabelText(/agents/i);
        expect(agentCounts.length).toBeGreaterThanOrEqual(2);
      });
    });

    it('renders coordinator AID for each team', async () => {
      vi.mocked(getTeams).mockResolvedValue({ teams: MOCK_ROOT_TEAMS });

      render(<TeamList />, { wrapper: makeWrapper() });

      await waitFor(() => {
        expect(screen.getAllByText('aid-lead-weather-abc1').length).toBeGreaterThan(0);
        expect(screen.getAllByText('aid-lead-code-abc2').length).toBeGreaterThan(0);
      });
    });

    it('assigns role="treeitem" to each team row', async () => {
      vi.mocked(getTeams).mockResolvedValue({ teams: MOCK_ROOT_TEAMS });

      render(<TeamList />, { wrapper: makeWrapper() });

      await waitFor(() => {
        const treeItems = screen.getAllByRole('treeitem');
        expect(treeItems.length).toBe(2);
      });
    });
  });

  // Expand / collapse
  describe('expand and collapse', () => {
    it('does not show inline detail section before expanding', async () => {
      vi.mocked(getTeams).mockResolvedValue({ teams: MOCK_ROOT_TEAMS });

      render(<TeamList />, { wrapper: makeWrapper() });

      await waitFor(() => expect(screen.getByText('weather-team')).not.toBeNull());

      // detail section is hidden initially
      expect(screen.queryByTestId('team-agents-weather-team')).toBeNull();
    });

    it('shows inline detail section after clicking a team node', async () => {
      vi.mocked(getTeams).mockResolvedValue({ teams: MOCK_ROOT_TEAMS });

      render(<TeamList />, { wrapper: makeWrapper() });

      await waitFor(() => expect(screen.getByText('weather-team')).not.toBeNull());

      fireEvent.click(screen.getByTestId('team-row-weather-team'));

      expect(screen.getByTestId('team-agents-weather-team')).not.toBeNull();
    });

    it('detail section shows agent list after expanding a team row', async () => {
      vi.mocked(getTeams).mockResolvedValue({ teams: MOCK_ROOT_TEAMS });
      vi.mocked(getAgents).mockResolvedValue(MOCK_WEATHER_AGENTS);

      render(<TeamList />, { wrapper: makeWrapper() });

      await waitFor(() => expect(screen.getByText('weather-team')).not.toBeNull());

      fireEvent.click(screen.getByTestId('team-row-weather-team'));

      const detail = screen.getByTestId('team-agents-weather-team');
      // Panel should show the "Agents" heading
      expect(detail.textContent).toContain('Agents');
      // And agent names from the mock
      await waitFor(() => {
        expect(detail.textContent).toContain('lead');
        expect(detail.textContent).toContain('analyst');
      });
    });

    it('collapses inline detail when clicking the same node again', async () => {
      vi.mocked(getTeams).mockResolvedValue({ teams: MOCK_ROOT_TEAMS });

      render(<TeamList />, { wrapper: makeWrapper() });

      await waitFor(() => expect(screen.getByText('weather-team')).not.toBeNull());

      fireEvent.click(screen.getByTestId('team-row-weather-team'));
      expect(screen.getByTestId('team-agents-weather-team')).not.toBeNull();

      // Click again to collapse
      fireEvent.click(screen.getByTestId('team-row-weather-team'));
      expect(screen.queryByTestId('team-agents-weather-team')).toBeNull();
    });

    it('sets aria-expanded="true" on treeitem when expanded', async () => {
      vi.mocked(getTeams).mockResolvedValue({ teams: MOCK_NESTED_TEAMS });

      render(<TeamList />, { wrapper: makeWrapper() });

      await waitFor(() => expect(screen.getByText('weather-team')).not.toBeNull());

      const weatherRow = screen.getByTestId('team-row-weather-team');
      expect(weatherRow.getAttribute('aria-expanded')).toBe('false');

      fireEvent.click(weatherRow);

      expect(weatherRow.getAttribute('aria-expanded')).toBe('true');
    });

    it('sets aria-expanded="false" on treeitem when collapsed', async () => {
      vi.mocked(getTeams).mockResolvedValue({ teams: MOCK_NESTED_TEAMS });

      render(<TeamList />, { wrapper: makeWrapper() });

      await waitFor(() => expect(screen.getByText('weather-team')).not.toBeNull());

      const weatherRow = screen.getByTestId('team-row-weather-team');
      expect(weatherRow.getAttribute('aria-expanded')).toBe('false');
    });
  });

  // Hierarchy
  describe('hierarchy and tree construction', () => {
    it('does not render child team before parent is expanded', async () => {
      vi.mocked(getTeams).mockResolvedValue({ teams: MOCK_NESTED_TEAMS });

      render(<TeamList />, { wrapper: makeWrapper() });

      await waitFor(() => expect(screen.getByText('weather-team')).not.toBeNull());

      // Child not visible until parent is expanded
      expect(screen.queryByText('forecast-team')).toBeNull();
    });

    it('renders child team after expanding the parent', async () => {
      vi.mocked(getTeams).mockResolvedValue({ teams: MOCK_NESTED_TEAMS });

      render(<TeamList />, { wrapper: makeWrapper() });

      await waitFor(() => expect(screen.getByText('weather-team')).not.toBeNull());

      fireEvent.click(screen.getByTestId('team-row-weather-team'));

      await waitFor(() => expect(screen.getByText('forecast-team')).not.toBeNull());
    });

    it('hides child team again when parent is collapsed', async () => {
      vi.mocked(getTeams).mockResolvedValue({ teams: MOCK_NESTED_TEAMS });

      render(<TeamList />, { wrapper: makeWrapper() });

      await waitFor(() => expect(screen.getByText('weather-team')).not.toBeNull());

      fireEvent.click(screen.getByTestId('team-row-weather-team'));
      await waitFor(() => expect(screen.getByText('forecast-team')).not.toBeNull());

      // Collapse
      fireEvent.click(screen.getByTestId('team-row-weather-team'));
      expect(screen.queryByText('forecast-team')).toBeNull();
    });

    it('renders three levels of nesting (CON-01 max depth)', async () => {
      vi.mocked(getTeams).mockResolvedValue({ teams: MOCK_THREE_LEVEL_TEAMS });

      render(<TeamList />, { wrapper: makeWrapper() });

      await waitFor(() => expect(screen.getByText('root-team')).not.toBeNull());

      // Expand root -> reveals mid
      fireEvent.click(screen.getByTestId('team-row-root-team'));
      await waitFor(() => expect(screen.getByText('mid-team')).not.toBeNull());

      // Expand mid -> reveals leaf
      fireEvent.click(screen.getByTestId('team-row-mid-team'));
      await waitFor(() => expect(screen.getByText('leaf-team')).not.toBeNull());
    });

    it('shows agent list panel when expanding a child team', async () => {
      vi.mocked(getTeams).mockResolvedValue({ teams: MOCK_NESTED_TEAMS });
      // Return an agent for forecast-team
      vi.mocked(getAgents).mockResolvedValue({
        agents: [
          { aid: 'aid-lead-forecast-abc3', name: 'forecast-lead', teamSlug: 'forecast-team', role: 'lead', status: 'idle', leadsTeam: 'tid-forecast-ccc', modelTier: null },
        ],
      });

      render(<TeamList />, { wrapper: makeWrapper() });

      await waitFor(() => expect(screen.getByText('weather-team')).not.toBeNull());

      // Expand weather-team to reveal forecast-team
      fireEvent.click(screen.getByTestId('team-row-weather-team'));
      await waitFor(() => expect(screen.getByText('forecast-team')).not.toBeNull());

      // Expand forecast-team to see its agent panel
      fireEvent.click(screen.getByTestId('team-row-forecast-team'));

      const detail = screen.getByTestId('team-agents-forecast-team');
      // Panel appears with Agents heading
      expect(detail.textContent).toContain('Agents');
      // Agent name from the mock
      await waitFor(() => {
        expect(detail.textContent).toContain('forecast-lead');
      });
    });

    it('teams with unknown parentSlug are treated as root nodes', async () => {
      const orphanTeams = [
        {
          tid: 'tid-orphan-xxx',
          slug: 'orphan-team',
          coordinatorAid: 'aid-orphan-abc1',
          health: 'running',
          agentCount: 1,
          depth: 2,
          parentSlug: 'nonexistent-parent',
        },
      ];
      vi.mocked(getTeams).mockResolvedValue({ teams: orphanTeams });

      render(<TeamList />, { wrapper: makeWrapper() });

      await waitFor(() => expect(screen.getByText('orphan-team')).not.toBeNull());

      // Should appear as a top-level node
      const treeItems = screen.getAllByRole('treeitem');
      expect(treeItems.length).toBe(1);
    });
  });

  // Refresh
  describe('refresh', () => {
    it('renders a refresh button', async () => {
      vi.mocked(getTeams).mockResolvedValue({ teams: MOCK_ROOT_TEAMS });

      render(<TeamList />, { wrapper: makeWrapper() });

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /refresh/i })).not.toBeNull()
      );
    });
  });
});
