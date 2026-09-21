import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './support/fixtures.ts';

const here = fileURLToPath(import.meta.url);
const evidenceDir = join(dirname(here), '..', '..', '..', 'docs', 'journeys', 'evidence', 'web-reader');
mkdirSync(join(evidenceDir, 'screenshots'), { recursive: true });

function writeEvidence(name: string, data: unknown): void {
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, name), JSON.stringify(data, null, 2));
}

test.describe('keyboard-only path, accessibility scan, and reference screenshots', () => {
  test('completes Universe -> Scroll -> Keep -> Next -> Home using only the keyboard', async ({ page }) => {
    await page.goto('/');
    // 1 Trace already kept by 01-reader-journey.spec.ts, which runs first in this single-worker suite.
    await expect(page.getByRole('heading', { name: 'Your first little world.' })).toBeVisible();

    await page.getByRole('button', { name: 'Enter Scroll' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('article')).toBeVisible();

    // Never bind ArrowRight to anything (no branch contract).
    const before = await page.content();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(150);
    const after = await page.content();
    expect(after).toBe(before);

    // ArrowDown/ArrowUp used to scroll the reading column by a fixed step, and
    // this test pressed them here as a harmless no-op on the way to Keep. The
    // down arrow is now "next discovery" once the Scroll has been read to its
    // end (definition.md sec.9.5, ui-system.md sec.4), so on a Scroll short
    // enough to fit the viewport this pair silently advanced to a *different*
    // Scroll before the Keep below -- which is why this test failed
    // intermittently depending on content height. ArrowDown's real contract is
    // asserted directly in 90-ui-system-evidence.spec.ts; this test is about
    // completing the journey on the keyboard, so it no longer presses them.
    await page.getByRole('button', { name: 'Keep this Scroll' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Kept' })).toBeVisible({ timeout: 5000 });

    await page.keyboard.press('n');
    await page.waitForTimeout(300);

    await page.keyboard.press('Escape');
    // This test just kept a second Trace; still 2, well under the "grown" threshold, so the
    // headline stays "Your first little world." (ui-system.md sec.5c).
    await expect(page.getByRole('heading', { name: 'Your first little world.' })).toBeVisible({ timeout: 5000 });
  });

  test('Universe screen has an accessible name path and no serious/critical axe violations', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Your first little world.' })).toBeVisible();
    const results = await new AxeBuilder({ page }).include('main').analyze();
    writeEvidence('axe-universe.json', results);
    const serious = results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
    expect(serious, JSON.stringify(serious, null, 2)).toHaveLength(0);
  });

  test('Scroll reader screen has no serious/critical axe violations', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Enter Scroll' }).click();
    await expect(page.getByRole('article')).toBeVisible();
    const results = await new AxeBuilder({ page }).include('main').analyze();
    writeEvidence('axe-scroll.json', results);
    const serious = results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
    expect(serious, JSON.stringify(serious, null, 2)).toHaveLength(0);
  });

  for (const viewport of [
    { name: '1440x900', width: 1440, height: 900 },
    { name: '1024x768', width: 1024, height: 768 },
  ]) {
    test(`reference screenshots at ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Your first little world.' })).toBeVisible();
      await page.screenshot({ path: join(evidenceDir, 'screenshots', `universe-${viewport.name}.png`), fullPage: true });

      await page.getByRole('button', { name: 'Enter Scroll' }).click();
      await expect(page.getByRole('article')).toBeVisible();
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(evidenceDir, 'screenshots', `scroll-${viewport.name}.png`), fullPage: true });

      await page.getByRole('button', { name: /Open sources panel/ }).click();
      await expect(page.getByRole('link', { name: /Open source/ })).toBeVisible();
      await page.screenshot({ path: join(evidenceDir, 'screenshots', `scroll-sources-${viewport.name}.png`), fullPage: true });
    });
  }
});
