/**
 * Dashboard Views — Red tests for all 7 views.
 *
 * These tests will fail until the dashboard is implemented in public/.
 * Each test navigates to a view hash route and asserts the expected
 * content is rendered.
 */

import { test, expect } from 'playwright/test';

const VIEWS = [
  { hash: '#/health',        heading: 'Health',        selector: '[data-view="health"]' },
  { hash: '#/org-tree',      heading: 'Org Tree',      selector: '[data-view="org-tree"]' },
  { hash: '#/tasks',         heading: 'Tasks',         selector: '[data-view="tasks"]' },
  { hash: '#/logs',          heading: 'Logs',          selector: '[data-view="logs"]' },
  { hash: '#/memories',      heading: 'Memories',      selector: '[data-view="memories"]' },
  { hash: '#/triggers',      heading: 'Triggers',      selector: '[data-view="triggers"]' },
  { hash: '#/conversations', heading: 'Conversations', selector: '[data-view="conversations"]' },
] as const;

test.describe('Dashboard Views', () => {
  for (const view of VIEWS) {
    test(`${view.hash} renders ${view.heading} view`, async ({ page }) => {
      await page.goto(`/${view.hash}`);

      // The view container should exist
      const container = page.locator(view.selector);
      await expect(container).toBeVisible({ timeout: 5_000 });

      // Should contain the heading text
      await expect(container).toContainText(view.heading);
    });
  }

  test('default route redirects to #/health', async ({ page }) => {
    await page.goto('/');

    // After load, the hash should be #/health
    await expect(page).toHaveURL(/\/#\/health/);
  });

  test('navigation between views updates content', async ({ page }) => {
    await page.goto('/#/health');
    await expect(page.locator('[data-view="health"]')).toBeVisible({ timeout: 5_000 });

    // Navigate to org-tree
    await page.goto('/#/org-tree');
    await expect(page.locator('[data-view="org-tree"]')).toBeVisible({ timeout: 5_000 });

    // Health view should no longer be visible
    await expect(page.locator('[data-view="health"]')).not.toBeVisible();
  });
});
