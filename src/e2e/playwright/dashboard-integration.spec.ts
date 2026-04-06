/**
 * Dashboard Integration — Post-suite verification tests.
 *
 * These tests verify that the dashboard correctly displays data
 * from the API after e2e suites have run. They expect a live server
 * with populated data.
 */

import { test, expect } from 'playwright/test';

test.describe('Dashboard Integration', () => {

  test('health view shows server status', async ({ page }) => {
    await page.goto('/#/health');

    const view = page.locator('[data-view="health"]');
    await expect(view).toBeVisible({ timeout: 5_000 });

    // Should display uptime or status indicator
    await expect(view.locator('[data-field="status"]')).toContainText(/ok|healthy/i);
  });

  test('org-tree view shows main team', async ({ page }) => {
    await page.goto('/#/org-tree');

    const view = page.locator('[data-view="org-tree"]');
    await expect(view).toBeVisible({ timeout: 5_000 });

    // main team should always be present
    await expect(view).toContainText('main');
  });

  test('tasks view renders task list', async ({ page }) => {
    await page.goto('/#/tasks');

    const view = page.locator('[data-view="tasks"]');
    await expect(view).toBeVisible({ timeout: 5_000 });

    // Should have a table or list element for tasks
    const list = view.locator('table, [role="list"], ul');
    await expect(list).toBeVisible({ timeout: 5_000 });
  });

  test('logs view renders log entries', async ({ page }) => {
    await page.goto('/#/logs');

    const view = page.locator('[data-view="logs"]');
    await expect(view).toBeVisible({ timeout: 5_000 });

    // Should have at least one log entry visible
    const entries = view.locator('[data-role="log-entry"], tr, li');
    await expect(entries.first()).toBeVisible({ timeout: 5_000 });
  });

  test('memories view renders memory list', async ({ page }) => {
    await page.goto('/#/memories');

    const view = page.locator('[data-view="memories"]');
    await expect(view).toBeVisible({ timeout: 5_000 });

    // main team memory should be shown
    await expect(view).toContainText('main');
  });

  test('triggers view renders trigger list', async ({ page }) => {
    await page.goto('/#/triggers');

    const view = page.locator('[data-view="triggers"]');
    await expect(view).toBeVisible({ timeout: 5_000 });

    // Should have a table or list element
    const list = view.locator('table, [role="list"], ul');
    await expect(list).toBeVisible({ timeout: 5_000 });
  });

  test('conversations view renders conversation history', async ({ page }) => {
    await page.goto('/#/conversations');

    const view = page.locator('[data-view="conversations"]');
    await expect(view).toBeVisible({ timeout: 5_000 });

    // Should have at least one conversation visible
    const entries = view.locator('[data-role="conversation"], tr, li');
    await expect(entries.first()).toBeVisible({ timeout: 5_000 });
  });

  test('API envelope format is { data, total?, error? }', async ({ request }) => {
    // Verify an API route returns the expected { data } envelope.
    // /health is NOT an API route (no envelope); use /api/v1/overview instead.
    const response = await request.get('/api/v1/overview');
    expect(response.ok()).toBeTruthy();

    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('data');
  });
});
