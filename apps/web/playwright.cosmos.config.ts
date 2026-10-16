import { defineConfig, devices, type Project } from '@playwright/test';

/**
 * ADR-0049: the cosmic-origin opening and the star Universe, against two disposable stacks started
 * by scripts/run-web-cosmos-journey.ts (each one scripts/run-web-cosmos-preview.ts: its own
 * `knowscroll_preview_*` database, real API, worker and Vite dev server, dropped afterwards):
 *
 *   PW_FRESH_URL  a first visit -- nothing recorded, so the opening plays and the seed is offered
 *   PW_GROWN_URL  a universe read into shape through the real HTTP API (--grow): Gravity and Tides
 *                 are stars, joined by a sourced relation, each with a question world, plus Traces
 *
 * Its own `testDir` keeps these out of the reader journey's default `./e2e` run (a three-Scroll
 * library with no substrate, so no star can form there) and keeps the reader specs, which need the
 * fault proxy and the dev token, out of this one. This config never starts a server and never
 * guesses a target. Every test gets a fresh browser context (Playwright's default), so "first visit"
 * really is one. Chromium on this Mac draws WebGL through ANGLE/Metal; `KS_PW_BROWSER=webkit` runs
 * the same specs in WebKit instead.
 */
function requiredUrl(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required (set by scripts/run-web-cosmos-journey.ts); Playwright never guesses a target.`);
  }
  return value;
}

const freshURL = requiredUrl('PW_FRESH_URL');
const grownURL = requiredUrl('PW_GROWN_URL');
const webkit = process.env.KS_PW_BROWSER === 'webkit';

const browser: Project['use'] = webkit
  ? { ...devices['Desktop Safari'] }
  : {
      ...devices['Desktop Chrome'],
      launchOptions: { args: ['--use-angle=metal', '--ignore-gpu-blocklist'] },
    };
const name = webkit ? 'webkit' : 'chromium';

export default defineConfig({
  testDir: './e2e-cosmos',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'artifacts/playwright-report-cosmos', open: 'never' }],
    ['json', { outputFile: 'artifacts/playwright-results-cosmos.json' }],
  ],
  outputDir: 'artifacts/test-results-cosmos',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: `${name}-fresh`, testMatch: /fresh\.spec\.ts$/, use: { ...browser, baseURL: freshURL } },
    { name: `${name}-grown`, testMatch: /grown\.spec\.ts$/, use: { ...browser, baseURL: grownURL } },
  ],
});
