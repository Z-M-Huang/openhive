import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for OpenHive web portal E2E tests.
 *
 * Tests run against the Vite dev server which proxies /api/v1 to the
 * Go backend. In CI, set the OPENHIVE_E2E_BASE_URL environment variable
 * to point at the compiled binary.
 */

const BASE_URL = process.env.OPENHIVE_E2E_BASE_URL ?? 'http://localhost:5173';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['html', { outputFolder: 'playwright-report', open: 'never' }]],

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Start the Vite dev server when not pointing at an external server.
  // The dev server returns a 200 on any route (SPA).
  webServer: process.env.OPENHIVE_E2E_BASE_URL
    ? undefined
    : {
        command: 'bun run dev --port 5173',
        port: 5173,
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
        stdout: 'ignore',
        stderr: 'pipe',
      },
});
