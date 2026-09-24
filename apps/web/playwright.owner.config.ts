import { defineConfig, devices } from '@playwright/test';

/**
 * #135: the owner-identity journey (magic link, cookie sign-in, account deletion) runs against a
 * *different* disposable stack than the reader journey's `playwright.config.ts` -- cookie mode
 * (`KS_WEB_AUTH=cookie`), no fault-injecting proxy, its own database and magic-link sink. It is
 * kept in its own config with its own `testDir` (`./e2e-owner`, never `./e2e`) specifically so the
 * reader journey's bare `pnpm exec playwright test` (the default config, `./e2e`) never picks up
 * this spec and tries to run it against the wrong stack -- and so this config's own run never picks
 * up the reader specs, which need fixtures (fault-proxy, dev-token bearer) this stack doesn't set.
 * Only `scripts/run-web-owner-journey.ts` runs this config, exactly like the reader journey is the
 * only thing that runs the default one.
 */
const baseURL = process.env.PW_BASE_URL;
if (!baseURL) {
  throw new Error('PW_BASE_URL is required (set by scripts/run-web-owner-journey.ts); Playwright never guesses a target.');
}

export default defineConfig({
  testDir: './e2e-owner',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'artifacts/playwright-report-owner', open: 'never' }],
    ['json', { outputFile: 'artifacts/playwright-results-owner.json' }],
  ],
  outputDir: 'artifacts/test-results-owner',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
