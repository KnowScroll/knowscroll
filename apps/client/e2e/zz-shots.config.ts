import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: ['zz-shots.spec.ts'],
  workers: 1,
  timeout: 120000,
  reporter: [['list']],
  outputDir: 'C:/Users/XZNON/knowscroll-dev/tmp/fix-universe/test-results',
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:4330' },
  webServer: { command: 'node serve-export.mjs ../dist 4330', url: 'http://127.0.0.1:4330/index.html', reuseExistingServer: true },
});
