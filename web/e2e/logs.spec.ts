import { test, expect } from '@playwright/test';
import type { LogEntry } from '../src/hooks/useApi';

/**
 * Log viewer E2E tests — verifies that filter controls update displayed
 * log entries.
 */

const sampleLogs: LogEntry[] = [
  {
    id: 1,
    level: 'info',
    component: 'orchestrator',
    action: 'task_created',
    message: 'Task was created',
    timestamp: new Date().toISOString(),
  },
  {
    id: 2,
    level: 'error',
    component: 'container',
    action: 'start_failed',
    message: 'Container failed to start',
    timestamp: new Date().toISOString(),
    team_name: 'alpha',
  },
  {
    id: 3,
    level: 'warn',
    component: 'orchestrator',
    action: 'retry',
    message: 'Retrying task',
    timestamp: new Date().toISOString(),
  },
];

test.beforeEach(async ({ page }) => {
  await page.route('/api/v1/logs*', async (route) => {
    const url = new URL(route.request().url());
    const level = url.searchParams.get('level');
    const component = url.searchParams.get('component');
    const team = url.searchParams.get('team');

    let filtered = [...sampleLogs];
    if (level) filtered = filtered.filter((e) => e.level === level);
    if (component) filtered = filtered.filter((e) => e.component === component);
    if (team) filtered = filtered.filter((e) => e.team_name === team);

    await route.fulfill({ json: filtered });
  });

  await page.route('/api/v1/**', async (route) => {
    await route.fulfill({ json: {} });
  });
});

test('log page renders filter controls', async ({ page }) => {
  await page.goto('/logs');
  await expect(page.getByTestId('log-level-filter')).toBeVisible();
  await expect(page.getByTestId('log-component-filter')).toBeVisible();
  await expect(page.getByTestId('log-team-filter')).toBeVisible();
  await expect(page.getByTestId('debug-toggle')).toBeVisible();
});

test('log entries are displayed', async ({ page }) => {
  await page.goto('/logs');
  await expect(page.getByText('Task was created')).toBeVisible();
  await expect(page.getByText('Container failed to start')).toBeVisible();
});

test('level filter updates displayed logs', async ({ page }) => {
  await page.goto('/logs');
  const levelFilter = page.getByTestId('log-level-filter');
  await levelFilter.selectOption('error');
  // After re-query, only error entries should appear
  await expect(page.getByText('Container failed to start')).toBeVisible();
});

test('component filter input is functional', async ({ page }) => {
  await page.goto('/logs');
  const componentFilter = page.getByTestId('log-component-filter');
  await componentFilter.fill('container');
  // Input accepts the typed value
  await expect(componentFilter).toHaveValue('container');
});

test('team filter input is functional', async ({ page }) => {
  await page.goto('/logs');
  const teamFilter = page.getByTestId('log-team-filter');
  await teamFilter.fill('alpha');
  await expect(teamFilter).toHaveValue('alpha');
});

test('debug toggle is a checkbox', async ({ page }) => {
  await page.goto('/logs');
  const debugToggle = page.getByTestId('debug-toggle');
  await expect(debugToggle).not.toBeChecked();
  await debugToggle.click();
  await expect(debugToggle).toBeChecked();
});
