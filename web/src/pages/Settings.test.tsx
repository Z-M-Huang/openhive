/**
 * Tests for the Settings page component.
 * Covers AC-G9: settings display with source badges, secret redaction,
 * editable fields, Save and Reload Config actions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { Settings } from './Settings';

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

import { getSettings, updateSettings, reloadConfig } from '@/services/api';

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

/**
 * A minimal mock SettingsResponse (SettingsData structure):
 * Top-level keys = sections, values = Record<fieldKey, FieldMeta>.
 */
const MOCK_SETTINGS = {
  server: {
    listen_address: { value: '127.0.0.1:8080', source: 'default' },
    log_level: { value: 'info', source: 'env' },
    data_dir: { value: '/app/data', source: 'yaml' },
  },
  security: {
    master_key: { value: '********', source: 'env', isSecret: true },
    require_auth: { value: false, source: 'default' },
  },
  limits: {
    max_teams: { value: 10, source: 'default' },
    max_depth: { value: 3, source: 'yaml' },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Settings page', () => {
  // -------------------------------------------------------------------------
  // Basic render
  // -------------------------------------------------------------------------

  it('renders the page heading', async () => {
    vi.mocked(getSettings).mockResolvedValue(MOCK_SETTINGS);

    render(<Settings />, { wrapper: makeWrapper() });

    expect(screen.getByText('Settings')).not.toBeNull();
  });

  it('shows loading state initially', () => {
    vi.mocked(getSettings).mockReturnValue(new Promise(() => {}));

    render(<Settings />, { wrapper: makeWrapper() });

    expect(screen.getByText('Loading settings...')).not.toBeNull();
  });

  it('shows error state when settings fetch fails', async () => {
    vi.mocked(getSettings).mockRejectedValue(new Error('Network error'));

    render(<Settings />, { wrapper: makeWrapper() });

    await waitFor(() =>
      expect(screen.getByText(/Failed to load settings/)).not.toBeNull()
    );
  });

  // -------------------------------------------------------------------------
  // Sections and fields
  // -------------------------------------------------------------------------

  it('renders settings sections after loading', async () => {
    vi.mocked(getSettings).mockResolvedValue(MOCK_SETTINGS);

    render(<Settings />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('server')).not.toBeNull());
    expect(screen.getByText('security')).not.toBeNull();
    expect(screen.getByText('limits')).not.toBeNull();
  });

  it('renders text input fields for string values', async () => {
    vi.mocked(getSettings).mockResolvedValue(MOCK_SETTINGS);

    render(<Settings />, { wrapper: makeWrapper() });

    await waitFor(() => {
      const input = screen.getByLabelText('Listen Address') as HTMLInputElement;
      expect(input.value).toBe('127.0.0.1:8080');
    });
  });

  it('renders number input fields for numeric values', async () => {
    vi.mocked(getSettings).mockResolvedValue(MOCK_SETTINGS);

    render(<Settings />, { wrapper: makeWrapper() });

    await waitFor(() => {
      const input = screen.getByLabelText('Max Teams') as HTMLInputElement;
      expect(input.type).toBe('number');
      expect(input.value).toBe('10');
    });
  });

  it('renders boolean toggle switch for boolean values', async () => {
    vi.mocked(getSettings).mockResolvedValue(MOCK_SETTINGS);

    render(<Settings />, { wrapper: makeWrapper() });

    await waitFor(() => {
      const toggle = screen.getByRole('switch', { name: /require auth/i });
      expect(toggle).not.toBeNull();
      expect(toggle.getAttribute('aria-checked')).toBe('false');
    });
  });

  // -------------------------------------------------------------------------
  // Secret field redaction
  // -------------------------------------------------------------------------

  it('renders secret fields as read-only with "********" value', async () => {
    vi.mocked(getSettings).mockResolvedValue(MOCK_SETTINGS);

    render(<Settings />, { wrapper: makeWrapper() });

    await waitFor(() => {
      const secretInput = screen.getByLabelText(/master key.*secret.*read-only/i) as HTMLInputElement;
      expect(secretInput.value).toBe('********');
      expect(secretInput.readOnly).toBe(true);
    });
  });

  it('does not render secret fields as editable', async () => {
    vi.mocked(getSettings).mockResolvedValue(MOCK_SETTINGS);

    render(<Settings />, { wrapper: makeWrapper() });

    await waitFor(() => screen.getByLabelText(/master key.*secret.*read-only/i));

    // The secret field should not be an editable input
    const secretInput = screen.getByLabelText(/master key.*secret.*read-only/i) as HTMLInputElement;
    expect(secretInput.readOnly).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Source badges
  // -------------------------------------------------------------------------

  it('renders source badges for each field', async () => {
    vi.mocked(getSettings).mockResolvedValue(MOCK_SETTINGS);

    render(<Settings />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('server')).not.toBeNull());

    // Should have env, yaml, default badges visible
    const envBadges = screen.getAllByText('env');
    const yamlBadges = screen.getAllByText('yaml');
    const defaultBadges = screen.getAllByText('default');

    expect(envBadges.length).toBeGreaterThan(0);
    expect(yamlBadges.length).toBeGreaterThan(0);
    expect(defaultBadges.length).toBeGreaterThan(0);
  });

  it('renders the source legend at the bottom', async () => {
    vi.mocked(getSettings).mockResolvedValue(MOCK_SETTINGS);

    render(<Settings />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('environment variable')).not.toBeNull());
    expect(screen.getByText('openhive.yaml')).not.toBeNull();
    expect(screen.getByText('compiled default')).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Field editing
  // -------------------------------------------------------------------------

  it('updates text field value when user types', async () => {
    vi.mocked(getSettings).mockResolvedValue(MOCK_SETTINGS);

    render(<Settings />, { wrapper: makeWrapper() });

    await waitFor(() => screen.getByLabelText('Listen Address'));

    const input = screen.getByLabelText('Listen Address') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0.0.0.0:9090' } });

    expect(input.value).toBe('0.0.0.0:9090');
  });

  it('updates number field value when user types', async () => {
    vi.mocked(getSettings).mockResolvedValue(MOCK_SETTINGS);

    render(<Settings />, { wrapper: makeWrapper() });

    await waitFor(() => screen.getByLabelText('Max Teams'));

    const input = screen.getByLabelText('Max Teams') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '20' } });

    expect(input.value).toBe('20');
  });

  it('toggles boolean field when switch is clicked', async () => {
    vi.mocked(getSettings).mockResolvedValue(MOCK_SETTINGS);

    render(<Settings />, { wrapper: makeWrapper() });

    await waitFor(() => screen.getByRole('switch', { name: /require auth/i }));

    const toggle = screen.getByRole('switch', { name: /require auth/i });
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  // -------------------------------------------------------------------------
  // Save button
  // -------------------------------------------------------------------------

  it('renders a Save button', async () => {
    vi.mocked(getSettings).mockResolvedValue(MOCK_SETTINGS);

    render(<Settings />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByRole('button', { name: /save settings/i })).not.toBeNull());
  });

  it('calls updateSettings with current edits when Save is clicked', async () => {
    vi.mocked(getSettings).mockResolvedValue(MOCK_SETTINGS);
    vi.mocked(updateSettings).mockResolvedValue({});

    render(<Settings />, { wrapper: makeWrapper() });

    // Wait for settings data to be rendered
    await waitFor(() => screen.getByLabelText('Listen Address'));

    // Change a value
    const input = screen.getByLabelText('Listen Address') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0.0.0.0:9090' } });

    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() => {
      expect(vi.mocked(updateSettings)).toHaveBeenCalledWith(
        expect.objectContaining({
          server: expect.objectContaining({ listen_address: '0.0.0.0:9090' }),
        })
      );
    });
  });

  it('shows "Saving..." text and disables Save button while save is pending', async () => {
    vi.mocked(getSettings).mockResolvedValue(MOCK_SETTINGS);
    // Never resolves — keeps mutation pending
    vi.mocked(updateSettings).mockReturnValue(new Promise(() => {}));

    render(<Settings />, { wrapper: makeWrapper() });

    // Wait for settings data to load (field must be visible before saving)
    await waitFor(() => screen.getByLabelText('Listen Address'));

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /save settings/i }));
    });

    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /save settings/i });
      expect(btn.textContent).toContain('Saving...');
      expect(btn.hasAttribute('disabled')).toBe(true);
    });
  });

  it('shows success banner after successful save', async () => {
    vi.mocked(getSettings).mockResolvedValue(MOCK_SETTINGS);
    vi.mocked(updateSettings).mockResolvedValue({});

    render(<Settings />, { wrapper: makeWrapper() });

    // Wait for settings data to be rendered
    await waitFor(() => screen.getByLabelText('Listen Address'));

    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() =>
      expect(screen.getByText('Settings saved successfully.')).not.toBeNull()
    );
  });

  it('shows error banner when save fails', async () => {
    vi.mocked(getSettings).mockResolvedValue(MOCK_SETTINGS);
    vi.mocked(updateSettings).mockRejectedValue(new Error('Validation failed'));

    render(<Settings />, { wrapper: makeWrapper() });

    // Wait for settings data to be rendered
    await waitFor(() => screen.getByLabelText('Listen Address'));

    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() =>
      expect(screen.getByText(/Failed to save settings/)).not.toBeNull()
    );
  });

  it('does not include secret fields in the save payload', async () => {
    vi.mocked(getSettings).mockResolvedValue(MOCK_SETTINGS);
    vi.mocked(updateSettings).mockResolvedValue({});

    render(<Settings />, { wrapper: makeWrapper() });

    // Wait for settings data to be rendered
    await waitFor(() => screen.getByLabelText('Listen Address'));
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() => expect(vi.mocked(updateSettings)).toHaveBeenCalled());

    const payload = vi.mocked(updateSettings).mock.calls[0][0] as Record<string, unknown>;
    const securitySection = payload.security as Record<string, unknown> | undefined;
    // master_key should not be present (it's a secret)
    expect(securitySection?.master_key).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Reload Config button
  // -------------------------------------------------------------------------

  it('renders a Reload Config button', async () => {
    vi.mocked(getSettings).mockResolvedValue(MOCK_SETTINGS);

    render(<Settings />, { wrapper: makeWrapper() });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /reload config/i })).not.toBeNull()
    );
  });

  it('calls reloadConfig when Reload Config is clicked', async () => {
    vi.mocked(getSettings).mockResolvedValue(MOCK_SETTINGS);
    vi.mocked(reloadConfig).mockResolvedValue({});

    render(<Settings />, { wrapper: makeWrapper() });

    // Wait for settings data to be rendered (Reload button is disabled until loaded)
    await waitFor(() => screen.getByLabelText('Listen Address'));
    fireEvent.click(screen.getByRole('button', { name: /reload config/i }));

    await waitFor(() => expect(vi.mocked(reloadConfig)).toHaveBeenCalled());
  });

  it('shows "Reloading..." text and disables Reload Config button while pending', async () => {
    vi.mocked(getSettings).mockResolvedValue(MOCK_SETTINGS);
    // Never resolves — keeps mutation pending
    vi.mocked(reloadConfig).mockReturnValue(new Promise(() => {}));

    render(<Settings />, { wrapper: makeWrapper() });

    // Wait for settings data to load before clicking
    await waitFor(() => screen.getByLabelText('Listen Address'));

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /reload config/i }));
    });

    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /reload config/i });
      expect(btn.textContent).toContain('Reloading...');
      expect(btn.hasAttribute('disabled')).toBe(true);
    });
  });

  it('shows reload success banner after successful reload', async () => {
    vi.mocked(getSettings).mockResolvedValue(MOCK_SETTINGS);
    vi.mocked(reloadConfig).mockResolvedValue({});

    render(<Settings />, { wrapper: makeWrapper() });

    // Wait for settings data to be rendered
    await waitFor(() => screen.getByLabelText('Listen Address'));
    fireEvent.click(screen.getByRole('button', { name: /reload config/i }));

    await waitFor(() =>
      expect(screen.getByText('Configuration reloaded from disk.')).not.toBeNull()
    );
  });

  it('shows error banner when reload fails', async () => {
    vi.mocked(getSettings).mockResolvedValue(MOCK_SETTINGS);
    vi.mocked(reloadConfig).mockRejectedValue(new Error('File not found'));

    render(<Settings />, { wrapper: makeWrapper() });

    // Wait for settings data to be rendered
    await waitFor(() => screen.getByLabelText('Listen Address'));
    fireEvent.click(screen.getByRole('button', { name: /reload config/i }));

    await waitFor(() =>
      expect(screen.getByText(/Failed to reload config/)).not.toBeNull()
    );
  });

  // -------------------------------------------------------------------------
  // Section ordering
  // -------------------------------------------------------------------------

  it('renders "server" section before "limits" in preferred order', async () => {
    vi.mocked(getSettings).mockResolvedValue(MOCK_SETTINGS);

    render(<Settings />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('server')).not.toBeNull());

    const headings = screen
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent?.trim());

    const serverIdx = headings.indexOf('server');
    const limitsIdx = headings.indexOf('limits');
    expect(serverIdx).toBeLessThan(limitsIdx);
  });

  // -------------------------------------------------------------------------
  // Empty sections are not rendered
  // -------------------------------------------------------------------------

  it('does not render an empty section', async () => {
    const settingsWithEmptySection = {
      ...MOCK_SETTINGS,
      empty_section: {},
    };
    vi.mocked(getSettings).mockResolvedValue(settingsWithEmptySection);

    render(<Settings />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('server')).not.toBeNull());

    expect(screen.queryByText('empty_section')).toBeNull();
  });
});
