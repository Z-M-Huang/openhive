import { test, expect } from '@playwright/test';

/**
 * Settings E2E tests — verifies that the settings form renders,
 * masked inputs work, and tabs are functional.
 *
 * Tabs use Radix Tabs.Trigger with data-testid="settings-tab-{name}".
 * MaskedInput uses data-testid="masked-input-display" and "masked-input-toggle".
 */

const mockConfig = {
  system: {
    listen_address: '127.0.0.1:8080',
    log_level: 'info',
    workspace_root: '/app/workspaces',
    data_dir: '/app/data',
  },
  assistant: {
    aid: 'aid-main-00000001',
    name: 'Main Assistant',
    provider: 'default',
    model_tier: 'sonnet',
  },
  channels: {
    discord: { enabled: false, token: '****4321', channel_id: '' },
    whatsapp: { enabled: false, store_path: '' },
  },
};

const mockProviders = {
  default: {
    type: 'oauth',
    oauth_token: '****abcd',
    haiku: 'claude-haiku-3-5',
    sonnet: 'claude-sonnet-4-5',
    opus: 'claude-opus-4-5',
  },
};

test.beforeEach(async ({ page }) => {
  await page.route('/api/v1/config', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: mockConfig });
    } else {
      await route.fulfill({ json: { ok: true } });
    }
  });
  await page.route('/api/v1/providers', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: mockProviders });
    } else {
      await route.fulfill({ json: { ok: true } });
    }
  });
  await page.route('/api/v1/**', async (route) => {
    await route.fulfill({ json: {} });
  });
});

test('settings page renders tab triggers', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByTestId('settings-tab-system')).toBeVisible();
  await expect(page.getByTestId('settings-tab-channels')).toBeVisible();
  await expect(page.getByTestId('settings-tab-providers')).toBeVisible();
});

test('system tab is the default active tab and shows log level', async ({ page }) => {
  await page.goto('/settings');
  // System tab content should be visible by default
  await expect(page.getByTestId('system-form')).toBeVisible();
  await expect(page.getByTestId('system-log-level')).toBeVisible();
});

test('channels tab shows channel forms on click', async ({ page }) => {
  await page.goto('/settings');
  await page.getByTestId('settings-tab-channels').click();
  // Discord channel form should be visible
  await expect(page.getByTestId('channel-form-discord')).toBeVisible();
  await expect(page.getByTestId('channel-form-whatsapp')).toBeVisible();
});

test('providers tab shows provider rows on click', async ({ page }) => {
  await page.goto('/settings');
  await page.getByTestId('settings-tab-providers').click();
  // Provider row with name "default" should be visible
  await expect(page.getByTestId('provider-row-default')).toBeVisible();
  await expect(page.getByText('default')).toBeVisible();
});

test('masked input shows masked value in channels tab', async ({ page }) => {
  await page.goto('/settings');
  await page.getByTestId('settings-tab-channels').click();
  // The masked display span for the Discord token
  const maskedDisplays = page.getByTestId('masked-input-display');
  await expect(maskedDisplays.first()).toBeVisible();
});

test('masked input Change button switches to edit mode', async ({ page }) => {
  await page.goto('/settings');
  await page.getByTestId('settings-tab-channels').click();
  // Click the Change button in the Discord form
  const changeBtn = page.getByTestId('masked-input-toggle').first();
  await expect(changeBtn).toHaveText('Change');
  await changeBtn.click();
  // After clicking, edit input appears and button changes to "Cancel"
  await expect(page.getByTestId('masked-input-field').first()).toBeVisible();
  await expect(changeBtn).toHaveText('Cancel');
});

test('save button is present on system tab', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByTestId('system-save')).toBeVisible();
});

test('save channels button is present on channels tab', async ({ page }) => {
  await page.goto('/settings');
  await page.getByTestId('settings-tab-channels').click();
  await expect(page.getByTestId('channels-save')).toBeVisible();
});
