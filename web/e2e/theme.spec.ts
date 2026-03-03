import { test, expect } from '@playwright/test';

/**
 * Theme toggle E2E tests — verifies that dark/light mode persists across
 * page reloads via localStorage.
 */

test.beforeEach(async ({ page }) => {
  // Mock all API calls
  await page.route('/api/v1/**', async (route) => {
    await route.fulfill({ json: {} });
  });
});

test('theme toggle button is visible', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('theme-toggle')).toBeVisible();
});

test('clicking theme toggle changes theme', async ({ page }) => {
  await page.goto('/');
  const toggle = page.getByTestId('theme-toggle');

  // Get initial theme state from documentElement
  const initialIsDark = await page.evaluate(() =>
    document.documentElement.classList.contains('dark'),
  );

  await toggle.click();

  const afterClickIsDark = await page.evaluate(() =>
    document.documentElement.classList.contains('dark'),
  );

  // Theme should have changed
  expect(afterClickIsDark).not.toBe(initialIsDark);
});

test('theme preference persists across page reload', async ({ page }) => {
  await page.goto('/');
  const toggle = page.getByTestId('theme-toggle');

  // Set to dark theme
  const isDark = await page.evaluate(() =>
    document.documentElement.classList.contains('dark'),
  );
  if (!isDark) {
    await toggle.click();
  }

  // Verify dark is active
  await expect(page.evaluate(() =>
    document.documentElement.classList.contains('dark'),
  )).resolves.toBe(true);

  // Verify localStorage was updated
  const storedTheme = await page.evaluate(() => localStorage.getItem('openhive-theme'));
  expect(storedTheme).toBe('dark');

  // Reload and verify dark theme is restored
  await page.reload();
  await expect(page.evaluate(() =>
    document.documentElement.classList.contains('dark'),
  )).resolves.toBe(true);
});

test('light theme persists across page reload', async ({ page }) => {
  // Force light theme in localStorage before navigation
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('openhive-theme', 'light'));
  await page.reload();

  const isDark = await page.evaluate(() =>
    document.documentElement.classList.contains('dark'),
  );
  expect(isDark).toBe(false);
});
