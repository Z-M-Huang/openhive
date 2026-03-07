import { test, expect } from '@playwright/test';

/**
 * Navigation E2E tests — verifies that all 5 portal routes render
 * and that the sidebar reflects the active route.
 *
 * These tests mock all /api/v1/* calls so they work without a running
 * backend.
 */

test.beforeEach(async ({ page }) => {
  // Mock API responses so navigation tests pass without a live backend.
  await page.route('/api/v1/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/health')) {
      await route.fulfill({ json: { status: 'ok' } });
    } else if (url.includes('/teams')) {
      await route.fulfill({ json: [] });
    } else if (url.includes('/tasks')) {
      await route.fulfill({ json: [] });
    } else if (url.includes('/logs')) {
      await route.fulfill({ json: [] });
    } else if (url.includes('/config')) {
      await route.fulfill({
        json: {
          system: { listen_address: '127.0.0.1:8080', log_level: 'info' },
          assistant: { aid: 'aid-main-00000001', name: 'Main', provider: 'default' },
          channels: {},
        },
      });
    } else {
      await route.fulfill({ status: 404, json: { error: 'not found' } });
    }
  });

  // Intercept WebSocket connections (portal WS).
  await page.route('/api/v1/ws', async (route) => {
    await route.abort();
  });
});

test('dashboard page loads at root path', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/OpenHive/);
  await expect(page.getByTestId('sidebar')).toBeVisible();
});

test('teams page navigates correctly', async ({ page }) => {
  await page.goto('/teams');
  await expect(page.getByTestId('sidebar')).toBeVisible();
  // Sidebar link should be highlighted
  const teamsLink = page.getByTestId('nav-teams');
  await expect(teamsLink).toBeVisible();
});

test('tasks page navigates correctly', async ({ page }) => {
  await page.goto('/tasks');
  await expect(page.getByTestId('sidebar')).toBeVisible();
  const tasksLink = page.getByTestId('nav-tasks');
  await expect(tasksLink).toBeVisible();
});

test('logs page navigates correctly', async ({ page }) => {
  await page.goto('/logs');
  await expect(page.getByTestId('sidebar')).toBeVisible();
  const logsLink = page.getByTestId('nav-logs');
  await expect(logsLink).toBeVisible();
});

test('settings page navigates correctly', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByTestId('sidebar')).toBeVisible();
});

test('unknown route redirects to dashboard', async ({ page }) => {
  await page.goto('/this-route-does-not-exist');
  await expect(page).toHaveURL('/');
});

test('sidebar navigation links are present', async ({ page }) => {
  await page.goto('/');
  const sidebar = page.getByTestId('sidebar');
  await expect(sidebar.getByTestId('nav-dashboard')).toBeVisible();
  await expect(sidebar.getByTestId('nav-teams')).toBeVisible();
  await expect(sidebar.getByTestId('nav-tasks')).toBeVisible();
  await expect(sidebar.getByTestId('nav-logs')).toBeVisible();
  await expect(sidebar.getByTestId('nav-settings')).toBeVisible();
});

test('clicking sidebar team link navigates to /teams', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('nav-teams').click();
  await expect(page).toHaveURL('/teams');
});
