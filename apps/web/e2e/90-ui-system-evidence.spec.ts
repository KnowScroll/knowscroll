import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Page } from '@playwright/test';
import { expect, test } from './support/fixtures.ts';

/**
 * #107 fidelity evidence, part 2 of 2 (see 00-ui-system-evidence-empty.spec.ts
 * for "Universe empty"). Numbered "90-" so it runs after every other spec
 * file: by now 01-reader-journey.spec.ts and 03-keyboard-and-a11y.spec.ts
 * have each already Kept a Scroll of their own -- there is no un-Keep in
 * this slice (docs/product/ui-system.md sec.6), and the feed only ever
 * offers the three-asset editorial library's *unkept* remainder
 * (apps/api/src/app.ts's `compose(assets, account.kept_asset_ids)`), so by
 * this point that pool may already be fully or partly spent. Every "read a
 * Scroll" need below except the dedicated exhaustion test therefore opens an
 * already-saved Trace (read-only, never competes for the unkept pool)
 * instead of a fresh discovery. Against the real disposable
 * API/worker/PostgreSQL from scripts/run-web-reader-journey.ts -- never a
 * mock.
 */
const here = fileURLToPath(import.meta.url);
const evidenceDir = join(dirname(here), '..', '..', '..', 'docs', 'journeys', 'evidence', 'web-ui');
const screenshotsDir = join(evidenceDir, 'screenshots');
mkdirSync(screenshotsDir, { recursive: true });

function writeEvidence(name: string, data: unknown): void {
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, name), JSON.stringify(data, null, 2));
}

const viewports = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1024x768', width: 1024, height: 768 },
] as const;

async function openSavedTrace(page: Page): Promise<void> {
  await expect(page.getByRole('navigation', { name: 'Saved Traces' })).toBeVisible();
  await page.getByRole('button', { name: /Revisit the saved Trace/ }).first().click();
  await expect(page.getByRole('article')).toBeVisible();
}

test.describe('ui-system.md fidelity evidence (#107)', () => {
  for (const viewport of viewports) {
    test(`reader, sources, why-this and Traces at ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Your universe' })).toBeVisible();

      // Universe with saved Traces: at least one already exists by this point in the run.
      await page.screenshot({ path: join(screenshotsDir, `universe-traces-${viewport.name}.png`), fullPage: true });

      // Reader: head band, context rail, reading column, truth pill adjacent to the claim.
      await openSavedTrace(page);
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(screenshotsDir, `reader-${viewport.name}.png`), fullPage: true });

      // Sources panel open (a cream sheet flanking the stage).
      await page.getByRole('button', { name: /Open sources panel/ }).click();
      await expect(page.getByRole('link', { name: /Open source/ })).toBeVisible();
      await page.screenshot({ path: join(screenshotsDir, `reader-sources-${viewport.name}.png`), fullPage: true });
      await page.getByRole('button', { name: /Close sources panel/ }).click();

      // Why this appeared open. A Trace revisit deliberately carries no recommendation reason
      // (docs/contracts/trace-revisit.md), so this also exercises the honest fallback copy.
      await page.getByRole('button', { name: 'Why this appeared' }).click();
      await expect(page.getByText('No explanation recorded.')).toBeVisible();
      await page.screenshot({ path: join(screenshotsDir, `reader-why-${viewport.name}.png`), fullPage: true });
      await page.getByRole('button', { name: 'Why this appeared' }).click();
    });
  }

  for (const viewport of viewports) {
    test(`end-of-library rest at ${viewport.name}: the finite three-asset editorial pool eventually empties`, async ({ page }) => {
      // A fresh page/context per viewport, not a reused one: a returning session restores its
      // last screen from storage on reload, so reusing one page across sizes would show the
      // previous iteration's Scroll instead of a fresh Universe.
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Your universe' })).toBeVisible({ timeout: 15000 });
      await page.getByRole('button', { name: 'Enter Scroll' }).click();
      const exhaustedHeading = page.getByRole('heading', { name: /reached the end of the current library/ }).first();
      // Either immediately exhausted (if earlier specs already kept every asset) or reading with
      // room for a short deliberate Next walk -- both are honest outcomes of the same finite,
      // unkept-only feed (content/editorial-scrolls.json has exactly three Scrolls). Wait for
      // *some* settled outcome first: `Next discovery`'s own actionability wait is not enough on
      // its own, because immediately after the click the button may not exist yet at all.
      await expect(page.getByRole('article').or(exhaustedHeading)).toBeVisible({ timeout: 15000 });
      for (let i = 0; i < 3; i++) {
        if (await exhaustedHeading.isVisible().catch(() => false)) break;
        // `.click()` waits for the button to exist and become actionable; no manual polling needed.
        await page.getByRole('button', { name: 'Next discovery' }).click();
        await page.waitForTimeout(300);
      }
      await expect(exhaustedHeading).toBeVisible({ timeout: 8000 });
      await page.screenshot({ path: join(screenshotsDir, `reader-exhausted-${viewport.name}.png`), fullPage: true });
    });
  }

  for (const viewport of viewports) {
    test(`unavailable at ${viewport.name}`, async ({ page, setOutage }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Your universe' })).toBeVisible();
      await setOutage(true);
      try {
        await page.reload();
        await expect(page.getByRole('heading', { name: 'The universe is unavailable' })).toBeVisible({ timeout: 8000 });
        await page.screenshot({ path: join(screenshotsDir, `universe-unavailable-${viewport.name}.png`), fullPage: true });
      } finally {
        await setOutage(false);
      }
    });
  }

  test('axe scan: Universe and Scroll reader carry no serious/critical violations', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Your universe' })).toBeVisible();
    const universeResults = await new AxeBuilder({ page }).include('main').analyze();
    writeEvidence('axe-universe.json', universeResults);
    const universeSerious = universeResults.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
    expect(universeSerious, JSON.stringify(universeSerious, null, 2)).toHaveLength(0);

    await openSavedTrace(page);
    await page.getByRole('button', { name: /Open sources panel/ }).click();
    await expect(page.getByRole('link', { name: /Open source/ })).toBeVisible();
    const readerResults = await new AxeBuilder({ page }).include('main').analyze();
    writeEvidence('axe-reader.json', readerResults);
    const readerSerious = readerResults.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
    expect(readerSerious, JSON.stringify(readerSerious, null, 2)).toHaveLength(0);
  });

  test('prefers-reduced-motion: reduce -- state still changes, instantly', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Your universe' })).toBeVisible();
    await page.screenshot({ path: join(screenshotsDir, 'universe-reduced-motion-1440x900.png'), fullPage: true });

    await openSavedTrace(page);
    await page.screenshot({ path: join(screenshotsDir, 'reader-reduced-motion-1440x900.png'), fullPage: true });
  });

  test('keyboard-only pass: tab through every control, focus visible', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Your universe' })).toBeVisible();
    // Tab through every control the Universe screen currently has (however
    // many saved Traces already exist by this point in the run, plus Enter
    // Scroll), confirming each Tab lands on a real, visibly focused control.
    const universeControlCount = await page.getByRole('button').count();
    for (let i = 0; i < universeControlCount; i++) {
      await page.keyboard.press('Tab');
      await expect(page.locator(':focus')).toBeVisible();
    }
    await page.screenshot({ path: join(screenshotsDir, 'universe-keyboard-focus-1440x900.png'), fullPage: true });

    await page.getByRole('button', { name: /Revisit the saved Trace/ }).first().focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('article')).toBeVisible();
    // Sources trigger -> Why trigger -> Kept (disabled, still tabbable) -> Next: walk them all.
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Tab');
      await expect(page.locator(':focus')).toBeVisible();
    }
    await page.screenshot({ path: join(screenshotsDir, 'reader-keyboard-focus-1440x900.png'), fullPage: true });
  });
});
