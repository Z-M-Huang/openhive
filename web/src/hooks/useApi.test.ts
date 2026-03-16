/**
 * Tests for new TanStack Query hooks added in step 19.
 * Tests useAgents, useContainers, useRestartContainer, useIntegrations,
 * useSettings, useUpdateSettings, useReloadConfig.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import {
  useAgents,
  useContainers,
  useRestartContainer,
  useIntegrations,
  useSettings,
  useUpdateSettings,
  useReloadConfig,
} from './useApi';

// ---------------------------------------------------------------------------
// Mock the api service module
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

import {
  getAgents,
  getContainers,
  restartContainer,
  getIntegrations,
  getSettings,
  updateSettings,
  reloadConfig,
} from '@/services/api';

// ---------------------------------------------------------------------------
// Test wrapper factory
// ---------------------------------------------------------------------------

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
      mutations: {
        retry: false,
      },
    },
  });

  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);

  return { wrapper, queryClient };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// useAgents
// ---------------------------------------------------------------------------

describe('useAgents', () => {
  it('calls getAgents and returns data', async () => {
    const agentsData = {
      agents: [
        {
          aid: 'aid-alpha-abc123',
          name: 'alpha',
          teamSlug: 'weather-team',
          role: 'member',
          status: 'idle',
          leadsTeam: false,
          modelTier: 'haiku',
        },
      ],
    };
    vi.mocked(getAgents).mockResolvedValueOnce(agentsData);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useAgents(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(agentsData);
    expect(getAgents).toHaveBeenCalledWith(undefined);
  });

  it('passes team filter param to getAgents', async () => {
    vi.mocked(getAgents).mockResolvedValueOnce({ agents: [] });

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useAgents({ team: 'weather-team' }), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(getAgents).toHaveBeenCalledWith({ team: 'weather-team' });
  });

  it('sets isError when getAgents rejects', async () => {
    vi.mocked(getAgents).mockRejectedValueOnce(new Error('Network error'));

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useAgents(), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// useContainers
// ---------------------------------------------------------------------------

describe('useContainers', () => {
  it('calls getContainers and returns data', async () => {
    const containersData = {
      containers: [
        {
          slug: 'weather-team',
          health: 'healthy',
          agentCount: 2,
          uptime: 3600,
          restartCount: 0,
          activeTaskCount: 1,
          childTeams: ['forecast-team'],
        },
      ],
    };
    vi.mocked(getContainers).mockResolvedValueOnce(containersData);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useContainers(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(containersData);
    expect(getContainers).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// useRestartContainer
// ---------------------------------------------------------------------------

describe('useRestartContainer', () => {
  it('calls restartContainer with slug and invalidates containers query on success', async () => {
    vi.mocked(restartContainer).mockResolvedValueOnce({ slug: 'weather-team', status: 'restarted' });
    vi.mocked(getContainers).mockResolvedValue({ containers: [] });

    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useRestartContainer(), { wrapper });

    result.current.mutate('weather-team');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(restartContainer).toHaveBeenCalledWith('weather-team');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['containers'] });
  });

  it('sets isError when restartContainer rejects', async () => {
    vi.mocked(restartContainer).mockRejectedValueOnce(new Error('Restart already in progress'));

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useRestartContainer(), { wrapper });

    result.current.mutate('weather-team');

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

// ---------------------------------------------------------------------------
// useIntegrations
// ---------------------------------------------------------------------------

describe('useIntegrations', () => {
  it('calls getIntegrations and returns data', async () => {
    const integrationsData = {
      integrations: [
        {
          id: 'intg-001',
          name: 'slack-notifier',
          teamSlug: 'weather-team',
          config_path: '/app/workspace/integrations/slack.yaml',
          status: 'active' as const,
          error_message: '',
          created_at: 1700000000000,
        },
      ],
    };
    vi.mocked(getIntegrations).mockResolvedValueOnce(integrationsData);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useIntegrations(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(integrationsData);
    expect(getIntegrations).toHaveBeenCalledWith(undefined);
  });

  it('passes team filter param to getIntegrations', async () => {
    vi.mocked(getIntegrations).mockResolvedValueOnce({ integrations: [] });

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useIntegrations({ team: 'weather-team' }), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(getIntegrations).toHaveBeenCalledWith({ team: 'weather-team' });
  });
});

// ---------------------------------------------------------------------------
// useSettings
// ---------------------------------------------------------------------------

describe('useSettings', () => {
  it('calls getSettings and returns data', async () => {
    const settingsData = {
      server: {
        log_level: { value: 'info', source: 'default' },
      },
    };
    vi.mocked(getSettings).mockResolvedValueOnce(settingsData);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useSettings(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(settingsData);
    expect(getSettings).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// useUpdateSettings
// ---------------------------------------------------------------------------

describe('useUpdateSettings', () => {
  it('calls updateSettings and invalidates settings query on success', async () => {
    const updatedSettings = { server: { log_level: { value: 'debug', source: 'yaml' } } };
    vi.mocked(updateSettings).mockResolvedValueOnce(updatedSettings);
    vi.mocked(getSettings).mockResolvedValue({});

    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useUpdateSettings(), { wrapper });

    result.current.mutate({ server: { log_level: 'debug' } });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(updateSettings).toHaveBeenCalledWith({ server: { log_level: 'debug' } });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['settings'] });
  });
});

// ---------------------------------------------------------------------------
// useReloadConfig
// ---------------------------------------------------------------------------

describe('useReloadConfig', () => {
  it('calls reloadConfig and invalidates settings query on success', async () => {
    const reloadedSettings = { server: { log_level: { value: 'info', source: 'default' } } };
    vi.mocked(reloadConfig).mockResolvedValueOnce(reloadedSettings);
    vi.mocked(getSettings).mockResolvedValue({});

    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useReloadConfig(), { wrapper });

    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(reloadConfig).toHaveBeenCalled();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['settings'] });
  });

  it('sets isError when reloadConfig rejects', async () => {
    vi.mocked(reloadConfig).mockRejectedValueOnce(new Error('Reload failed'));

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useReloadConfig(), { wrapper });

    result.current.mutate();

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
