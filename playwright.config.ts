import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test/browser',
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:4189',
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'light',
    launchOptions: { executablePath: process.env.CHITTR_BROWSER || undefined },
  },
  outputDir: '.local/browser-results',
  webServer: {
    command: 'node --import tsx scripts/web-fixture-runner.ts',
    url: 'http://127.0.0.1:4189',
    timeout: 15000,
    reuseExistingServer: false,
  },
});
