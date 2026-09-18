import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'test/ui',
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:8788',
    headless: true,
    channel: process.env.PLAYWRIGHT_CHANNEL,
  },
  webServer: {
    command: 'node --import tsx test/ui-server.ts',
    url: 'http://127.0.0.1:8788',
    reuseExistingServer: false,
  },
  reporter: 'list',
});
