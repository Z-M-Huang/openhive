/**
 * Tests for new API service functions added in step 19.
 * Tests agents, containers, integrations, and settings endpoints.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getAgents,
  getContainers,
  restartContainer,
  getIntegrations,
  getSettings,
  updateSettings,
  reloadConfig,
} from './api';

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

function mockFetchOk(body: unknown): void {
  global.fetch = vi.fn().mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve(body),
  } as Response);
}

function mockFetchError(status: number, errorBody: unknown): void {
  global.fetch = vi.fn().mockResolvedValueOnce({
    ok: false,
    status,
    json: () => Promise.resolve(errorBody),
  } as unknown as Response);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

describe('getAgents', () => {
  it('calls GET /api/agents and returns agents list', async () => {
    const expected = {
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
    mockFetchOk(expected);

    const result = await getAgents();

    expect(global.fetch).toHaveBeenCalledWith('/api/agents', expect.objectContaining({
      headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
    }));
    expect(result).toEqual(expected);
  });

  it('calls GET /api/agents?team=<slug> when team param is provided', async () => {
    mockFetchOk({ agents: [] });

    await getAgents({ team: 'weather-team' });

    expect(global.fetch).toHaveBeenCalledWith('/api/agents?team=weather-team', expect.any(Object));
  });

  it('throws an error when the response is not ok', async () => {
    mockFetchError(500, { error: 'Internal server error' });

    await expect(getAgents()).rejects.toThrow('Internal server error');
  });
});

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

describe('getContainers', () => {
  it('calls GET /api/containers and returns containers list', async () => {
    const expected = {
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
    mockFetchOk(expected);

    const result = await getContainers();

    expect(global.fetch).toHaveBeenCalledWith('/api/containers', expect.objectContaining({
      headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
    }));
    expect(result).toEqual(expected);
  });

  it('throws when response is not ok', async () => {
    mockFetchError(503, { error: 'Service unavailable' });

    await expect(getContainers()).rejects.toThrow('Service unavailable');
  });
});

describe('restartContainer', () => {
  it('calls POST /api/containers/:slug/restart', async () => {
    const expected = { slug: 'weather-team', status: 'restarted' };
    mockFetchOk(expected);

    const result = await restartContainer('weather-team');

    expect(global.fetch).toHaveBeenCalledWith('/api/containers/weather-team/restart', expect.objectContaining({
      method: 'POST',
    }));
    expect(result).toEqual(expected);
  });

  it('throws when restart is already in progress (409)', async () => {
    mockFetchError(409, { error: 'Restart already in progress for team' });

    await expect(restartContainer('weather-team')).rejects.toThrow('Restart already in progress for team');
  });
});

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

describe('getIntegrations', () => {
  it('calls GET /api/integrations and returns integrations list', async () => {
    const expected = {
      integrations: [
        {
          id: 'intg-001',
          name: 'slack-notifier',
          teamSlug: 'weather-team',
          config_path: '/app/workspace/integrations/slack.yaml',
          status: 'active',
          created_at: 1700000000000,
        },
      ],
    };
    mockFetchOk(expected);

    const result = await getIntegrations();

    expect(global.fetch).toHaveBeenCalledWith('/api/integrations', expect.objectContaining({
      headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
    }));
    expect(result).toEqual(expected);
  });

  it('calls GET /api/integrations?team=<slug> when team param is provided', async () => {
    mockFetchOk({ integrations: [] });

    await getIntegrations({ team: 'weather-team' });

    expect(global.fetch).toHaveBeenCalledWith('/api/integrations?team=weather-team', expect.any(Object));
  });

  it('throws when response is not ok', async () => {
    mockFetchError(500, { error: 'Internal server error' });

    await expect(getIntegrations()).rejects.toThrow('Internal server error');
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe('getSettings', () => {
  it('calls GET /api/settings and returns settings', async () => {
    const expected = {
      server: {
        log_level: { value: 'info', source: 'default' },
        listen_address: { value: '127.0.0.1:8080', source: 'default' },
      },
    };
    mockFetchOk(expected);

    const result = await getSettings();

    expect(global.fetch).toHaveBeenCalledWith('/api/settings', expect.objectContaining({
      headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
    }));
    expect(result).toEqual(expected);
  });

  it('throws when response is not ok', async () => {
    mockFetchError(500, { error: 'Internal server error' });

    await expect(getSettings()).rejects.toThrow('Internal server error');
  });
});

describe('updateSettings', () => {
  it('calls PUT /api/settings with the update payload', async () => {
    const payload = { server: { log_level: 'debug' } };
    const expected = {
      server: {
        log_level: { value: 'debug', source: 'yaml' },
      },
    };
    mockFetchOk(expected);

    const result = await updateSettings(payload);

    expect(global.fetch).toHaveBeenCalledWith('/api/settings', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify(payload),
    }));
    expect(result).toEqual(expected);
  });

  it('throws when response is not ok', async () => {
    mockFetchError(400, { error: 'Validation failed' });

    await expect(updateSettings({})).rejects.toThrow('Validation failed');
  });
});

describe('reloadConfig', () => {
  it('calls POST /api/settings/reload and returns updated settings', async () => {
    const expected = {
      server: {
        log_level: { value: 'info', source: 'default' },
      },
    };
    mockFetchOk(expected);

    const result = await reloadConfig();

    expect(global.fetch).toHaveBeenCalledWith('/api/settings/reload', expect.objectContaining({
      method: 'POST',
    }));
    expect(result).toEqual(expected);
  });

  it('throws when response is not ok', async () => {
    mockFetchError(500, { error: 'Reload failed' });

    await expect(reloadConfig()).rejects.toThrow('Reload failed');
  });
});
