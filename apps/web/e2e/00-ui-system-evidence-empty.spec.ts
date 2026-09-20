import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './support/fixtures.ts';

/**
 * #107 fidelity evidence, part 1 of 2 (see 90-ui-system-evidence.spec.ts for
 * the rest). Numbered "00-" so it is the very first spec file the runner
 * picks up in the whole disposable-database run: 01-reader-journey.spec.ts's
 * own first test asserts a genuinely empty universe, and there is no
 * un-Keep in this slice, so the "Universe empty" screenshot must be taken
 * here, before any spec (including this one) performs a Keep.
 */
const here = fileURLToPath(import.meta.url);
const screenshotsDir = join(dirname(here), '..', '..', '..', 'docs', 'journeys', 'evidence', 'web-ui', 'screenshots');
mkdirSync(screenshotsDir, { recursive: true });

const viewports = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1024x768', width: 1024, height: 768 },
] as const;

test('Universe empty, at both sizes, before anything in this run has kept a Scroll', async ({ page }) => {
  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Your universe' })).toBeVisible();
    await expect(page.getByText('Nothing lives here yet.', { exact: false })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Saved Traces' })).toHaveCount(0);
    await page.screenshot({ path: join(screenshotsDir, `universe-empty-${viewport.name}.png`), fullPage: true });
  }
});
