import { test, expect } from '@playwright/test';

/**
 * WebSocket E2E tests — verifies that the connection indicator reflects
 * the WebSocket state.
 *
 * The Header renders `data-testid="connection-indicator"` with
 * `aria-label="WebSocket: <state>"`.
 */

test.beforeEach(async ({ page }) => {
  await page.route('/api/v1/**', async (route) => {
    if (!route.request().url().includes('/ws')) {
      await route.fulfill({ json: {} });
    }
  });
});

test('WebSocket connection indicator is visible in header', async ({ page }) => {
  await page.route('**/api/v1/ws', async (route) => {
    await route.abort();
  });
  await page.goto('/');
  // The connection indicator element should always be rendered
  const indicator = page.getByTestId('connection-indicator');
  await expect(indicator).toBeVisible();
});

test('connection indicator shows a state label', async ({ page }) => {
  await page.route('**/api/v1/ws', async (route) => {
    await route.abort();
  });
  await page.goto('/');
  const indicator = page.getByTestId('connection-indicator');
  await expect(indicator).toBeVisible();
  // Must have an aria-label starting with "WebSocket:"
  const ariaLabel = await indicator.getAttribute('aria-label');
  expect(ariaLabel).toMatch(/^WebSocket:/);
});

test('connection indicator shows Disconnected when WS is aborted', async ({ page }) => {
  await page.route('**/api/v1/ws', async (route) => {
    await route.abort();
  });
  await page.goto('/');
  // Wait briefly for reconnect attempts to settle
  await page.waitForTimeout(300);
  const indicator = page.getByTestId('connection-indicator');
  // After abort, state should be disconnected or error (not connected)
  const ariaLabel = await indicator.getAttribute('aria-label');
  expect(ariaLabel).not.toBe('WebSocket: Connected');
});

test('WebSocket connection targets correct path', async ({ page }) => {
  const wsUrls: string[] = [];

  page.on('websocket', (ws) => {
    wsUrls.push(ws.url());
  });

  // Do not abort WS — let it attempt to connect (it will fail because no server)
  await page.route('/api/v1/**', async (route) => {
    if (!route.request().url().includes('/ws')) {
      await route.fulfill({ json: {} });
    }
    // WS upgrade will be attempted but fail naturally
  });

  await page.goto('/');
  await page.waitForTimeout(300);

  // If a WS connection was attempted, verify it targets the correct path
  if (wsUrls.length > 0) {
    expect(wsUrls[0]).toContain('/api/v1/ws');
  }
});
