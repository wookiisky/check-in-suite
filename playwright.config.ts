import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './web/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:15173',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'iphone14-webkit', use: { ...devices['iPhone 14'] } },
  ],
  webServer: [
    {
      name: 'api',
      command: 'node scripts/e2e-api.mjs',
      url: 'http://127.0.0.1:18080/health/ready',
      reuseExistingServer: false,
      timeout: 120_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    },
    {
      name: 'web',
      command: 'npm run dev:web -- --port 15173',
      env: { ISLAND_API_TARGET: 'http://127.0.0.1:18080' },
      url: 'http://127.0.0.1:15173',
      reuseExistingServer: false,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
  ],
});
