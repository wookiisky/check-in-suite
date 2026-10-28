import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './web/e2e',
  // 单账户端到端流程串行运行，避免测试之间互相改动余额和资料。
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:15173',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } } },
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
