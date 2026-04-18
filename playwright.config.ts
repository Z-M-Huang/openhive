import { defineConfig } from 'playwright/test';

export default defineConfig({
  testDir: './tests/uat',
  testMatch: /.*\.spec\.ts$/,
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:8080',
    headless: true,
  },
  reporter: [['list']],
});
