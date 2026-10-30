import { defineConfig, devices } from '@playwright/test';

/**
 * The web smoke (#227 review M2): Chromium over the static exports, served like the edge serves
 * them (with its headers, the Content-Security-Policy included: S1.3 review m7). `production` runs against `dist/` (the export that ships); `gallery` against
 * `dist-gallery/` (built with EXPO_PUBLIC_KS_GALLERY=1, never shipped). CI builds both first
 * (`pnpm --filter @knowscroll/client build` and `build:gallery`); browsers are installed in CI
 * only (`playwright install --with-deps chromium`).
 */
const production = 4310;
const gallery = 4311;

export default defineConfig({
  testDir: '.',
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  outputDir: '../test-results',
  use: { ...devices['Desktop Chrome'], trace: 'retain-on-failure' },
  projects: [
    {
      name: 'production',
      testMatch: [
        'web-smoke.spec.ts',
        'auth-smoke.spec.ts',
        'account-smoke.spec.ts',
        'security-smoke.spec.ts',
        'encounter-smoke.spec.ts',
        'recording-smoke.spec.ts',
        'keep-smoke.spec.ts',
        'friends-smoke.spec.ts',
        'universe-smoke.spec.ts',
        'a11y-smoke.spec.ts',
        'talk-smoke.spec.ts',
        'thread-phone-smoke.spec.ts',
        'reflow-smoke.spec.ts',
        'keyboard-smoke.spec.ts',
        'privacy-smoke.spec.ts',
        'desktop-smoke.spec.ts',
        'feedback-smoke.spec.ts',
        'rooms-smoke.spec.ts',
      ],
      use: { baseURL: `http://127.0.0.1:${production}` },
    },
    {
      name: 'gallery',
      testMatch: ['gallery-smoke.spec.ts', 'scroll-gallery.spec.ts', 'scroll-blocks.spec.ts'],
      use: { baseURL: `http://127.0.0.1:${gallery}` },
    },
  ],
  webServer: [
    {
      command: `node serve-export.mjs ../dist ${production}`,
      url: `http://127.0.0.1:${production}/index.html`,
      reuseExistingServer: false,
    },
    {
      command: `node serve-export.mjs ../dist-gallery ${gallery}`,
      url: `http://127.0.0.1:${gallery}/index.html`,
      reuseExistingServer: false,
    },
  ],
});
