import { test as base } from '@playwright/test';

/**
 * ADR-0049 §5: a browser that has never finished or skipped the cosmic-origin opening, and has not
 * yet observed a universe, sees a ~28 s overlay before its Universe (`data-testid="origin"`, the
 * app shell `inert` until handoff). Every Playwright test gets a fresh browser context, so without
 * this every journey written before the opening existed would start under that overlay.
 *
 * `originSeen` (default `true`) records, before any page script runs, exactly what the app itself
 * writes when a reader finishes or skips the opening (`apps/web/src/cosmos/originStorage.ts`), so
 * those journeys start at the Universe as they always did. It runs on every navigation and reload
 * in the context, so a spec that purges storage still lands on the Universe. A spec about the
 * opening itself opts out with `test.use({ originSeen: false })`; apps/web/e2e-cosmos/ proves the
 * opening against its own disposable stacks (playwright.cosmos.config.ts).
 */
export const ORIGIN_STORAGE_KEY = 'ks_origin_v1';

export function markOriginSeenInit(key: string): void {
  try {
    window.localStorage.setItem(key, 'seen');
  } catch {
    // Storage blocked (a sandboxed frame): the app then behaves as a first visit, which a spec sees.
  }
}

export interface OriginOptions {
  originSeen: boolean;
}

export const test = base.extend<OriginOptions>({
  originSeen: [true, { option: true }],
  context: async ({ context, originSeen }, use) => {
    if (originSeen) await context.addInitScript(markOriginSeenInit, ORIGIN_STORAGE_KEY);
    await use(context);
  },
});

export { expect } from '@playwright/test';
