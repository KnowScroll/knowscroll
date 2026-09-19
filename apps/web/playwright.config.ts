import { defineConfig, devices } from '@playwright/test';

/**
 * Journeys run only against a disposable API/worker/PostgreSQL and a Vite dev
 * server started by scripts/run-web-reader-journey.ts; this config never
 * starts its own webServer or reaches an owner database. `PW_BASE_URL` is
 * required and points at that disposable dev server's loopback origin.
 */
const baseURL = process.env.PW_BASE_URL;
if (!baseURL) {
  throw new Error('PW_BASE_URL is required (set by scripts/run-web-reader-journey.ts); Playwright never guesses a target.');
}

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'artifacts/playwright-report', open: 'never' }],
    ['json', { outputFile: 'artifacts/playwright-results.json' }],
  ],
  outputDir: 'artifacts/test-results',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
