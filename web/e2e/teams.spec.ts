import { test, expect } from '@playwright/test';
import type { Team } from '../src/hooks/useApi';

/**
 * Teams E2E tests — verifies that the team tree renders, expand/collapse
 * works, and agent status badges are shown.
 */

const mockTeams: Team[] = [
  {
    slug: 'alpha',
    tid: 'tid-alpha-00000001',
    leader_aid: 'aid-lead-00000001',
    container_state: 'running',
    agents: [
      { aid: 'aid-lead-00000001', name: 'Alpha Lead' },
      { aid: 'aid-agent-00000001', name: 'Agent One' },
    ],
    children: ['beta'],
  },
  {
    slug: 'beta',
    tid: 'tid-beta-00000001',
    leader_aid: 'aid-lead-00000002',
    parent_slug: 'alpha',
    container_state: 'stopped',
    agents: [{ aid: 'aid-lead-00000002', name: 'Beta Lead' }],
    children: [],
  },
];

test.beforeEach(async ({ page }) => {
  await page.route('/api/v1/teams', async (route) => {
    await route.fulfill({ json: mockTeams });
  });
  await page.route('/api/v1/teams/**', async (route) => {
    await route.fulfill({ json: mockTeams[0] });
  });
  await page.route('/api/v1/**', async (route) => {
    await route.fulfill({ json: {} });
  });
});

test('teams page renders the team tree', async ({ page }) => {
  await page.goto('/teams');
  await expect(page.getByTestId('team-node-alpha')).toBeVisible();
});

test('root team shows container state', async ({ page }) => {
  await page.goto('/teams');
  const stateDot = page.getByTestId('team-state-alpha');
  await expect(stateDot).toBeVisible();
  await expect(stateDot).toHaveAttribute('aria-label', 'Container: running');
});

test('child team is visible when parent is expanded at depth 0', async ({ page }) => {
  await page.goto('/teams');
  // depth=0 starts expanded
  await expect(page.getByTestId('team-node-beta')).toBeVisible();
});

test('agent list is visible on toggle', async ({ page }) => {
  await page.goto('/teams');
  const agentsToggle = page.getByTestId('team-agents-toggle-alpha');
  await agentsToggle.click();
  await expect(page.getByTestId('team-agents-alpha')).toBeVisible();
  await expect(page.getByTestId('agent-badge-aid-lead-00000001')).toBeVisible();
});

test('agent list hides on second click', async ({ page }) => {
  await page.goto('/teams');
  const agentsToggle = page.getByTestId('team-agents-toggle-alpha');
  await agentsToggle.click();
  await agentsToggle.click();
  await expect(page.getByTestId('team-agents-alpha')).not.toBeVisible();
});
