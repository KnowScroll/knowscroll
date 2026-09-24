import { defineConfig, devices } from '@playwright/test';

/**
 * #133: the "What led here" journey runs against its own disposable stack
 * (scripts/run-web-why-journey.ts): cookie mode like the owner journey, but the product library
 * with its editorial substrate and a worker. Its own `testDir` (`./e2e-why`) keeps it out of the
 * reader journey's default `./e2e` run (a three-Scroll library with no substrate, where every
 * encounter is an unmapped fallback) and keeps the reader specs out of this one -- exactly the
 * separation playwright.owner.config.ts documents.
 */
const baseURL = process.env.PW_BASE_URL;
if (!baseURL) {
  throw new Error('PW_BASE_URL is required (set by scripts/run-web-why-journey.ts); Playwright never guesses a target.');
}

export default defineConfig({
  testDir: './e2e-why',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'artifacts/playwright-report-why', open: 'never' }],
    ['json', { outputFile: 'artifacts/playwright-results-why.json' }],
  ],
  outputDir: 'artifacts/test-results-why',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
});
