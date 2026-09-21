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
      await expect(page.getByRole('heading', { name: 'Your curiosity leaves a trace.' })).toBeVisible();

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

  // A bounded 100vh reader trades page scrolling for the risk that something
  // lands outside the box and no scroll can reach it. These sizes are ordinary
  // desktop windows, not edge cases: a short laptop window, and a narrow one
  // below the rail-collapse breakpoint.
  const crampedViewports = [
    { name: '1440x420', width: 1440, height: 420 },
    { name: '1280x420', width: 1280, height: 420 },
    { name: '1024x420', width: 1024, height: 420 },
    { name: '900x420', width: 900, height: 420 },
    { name: '1024x560', width: 1024, height: 560 },
    { name: '700x560', width: 700, height: 560 },
    { name: '650x420', width: 650, height: 420 },
  ];

  /** The invariant that matters: nothing may sit outside the clipped stage,
   *  where a mouse-only reader has no scrollbar to reach it. Playwright's own
   *  `scrollIntoViewIfNeeded` can scroll an `overflow:hidden` ancestor, so
   *  "the control is in the viewport" is not on its own proof of reachability. */
  const expectNothingClipped = async (page: import('@playwright/test').Page, where: string) => {
    const clipped = await page.locator('.scroll-screen').evaluate(n => n.scrollHeight > n.clientHeight + 1);
    expect(clipped, `.scroll-screen must never clip content out of reach (${where})`).toBe(false);
  };

  for (const viewport of crampedViewports) {
    test(`every control stays reachable at ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/');
      await openSavedTrace(page);

      // Keep must be reachable by scrolling whatever actually scrolls.
      const keep = page.getByRole('button', { name: /Keep this Scroll|Kept/ });
      await keep.scrollIntoViewIfNeeded();
      await expect(keep).toBeInViewport();

      // Above the breakpoint the context rail is present, so the why-this sheet
      // must not grow past the bottom of a clipped screen. Below it the rail is
      // collapsed by design and the whole stage flows instead, so the source
      // sheet is what has to stay reachable.
      await expectNothingClipped(page, 'reading');

      // Both sheets, not just the one that was fixed first. The source sheet
      // carries evidence access (definition.md law 9), so a reader who cannot
      // see "Open source" has lost the point of the surface.
      if (viewport.width > 700) {
        await page.getByRole('button', { name: 'Why this appeared' }).click();
        await expect(page.getByText('No explanation recorded.')).toBeVisible();
        await expectNothingClipped(page, 'why-this open');
        await page.getByRole('button', { name: 'Why this appeared' }).click();
      } else {
        await expect(page.locator('.context-rail')).toBeHidden();
      }

      await page.keyboard.press('s');
      const link = page.getByRole('link', { name: /Open source/ });
      await expect(link).toBeVisible();
      await expectNothingClipped(page, 'sources open');
      await link.scrollIntoViewIfNeeded();
      await expect(link).toBeInViewport();
    });
  }

  test('the context rail really does collapse below 700px', async ({ page }) => {
    // The collapse rule existed but sat before an unconditional rule of equal
    // specificity, so the cascade silently discarded it.
    await page.setViewportSize({ width: 660, height: 800 });
    await page.goto('/');
    await openSavedTrace(page);
    await expect(page.locator('.context-rail')).toBeHidden();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator('.context-rail')).toBeVisible();
  });

  test('resizing across the breakpoint mid-read keeps the reader where they were', async ({ page }) => {
    // Maximising, un-maximising or tiling a window is ordinary. Crossing 700px
    // swaps which element scrolls, and the new one starts at zero, so the depth
    // has to be carried over as a fraction -- the same text is a different
    // height in a narrower column, so an absolute offset lands elsewhere.
    await page.setViewportSize({ width: 1440, height: 420 });
    await page.goto('/');
    await openSavedTrace(page);
    const article = page.locator('.reading-column');
    const stage = page.locator('.scroll-layout');
    await expect(article).toBeVisible();

    const depth = await article.evaluate(n => {
      n.scrollTop = Math.round((n.scrollHeight - n.clientHeight) * 0.6);
      return n.scrollTop / (n.scrollHeight - n.clientHeight);
    });
    expect(depth).toBeGreaterThan(0.5);

    await page.setViewportSize({ width: 650, height: 420 });
    await expect.poll(() => stage.evaluate(n => n.scrollTop)).toBeGreaterThan(0);
    const afterNarrow = await stage.evaluate(n => n.scrollTop / (n.scrollHeight - n.clientHeight));
    expect(afterNarrow, 'depth is preserved going narrow').toBeCloseTo(depth, 1);

    // And back the other way.
    await page.setViewportSize({ width: 1440, height: 420 });
    await expect.poll(() => article.evaluate(n => n.scrollTop)).toBeGreaterThan(0);
    const afterWide = await article.evaluate(n => n.scrollTop / (n.scrollHeight - n.clientHeight));
    expect(afterWide, 'depth is preserved going wide').toBeCloseTo(depth, 1);
  });

  test('reading position survives a reload below the breakpoint, where the stage scrolls, not the article', async ({ page }) => {
    // The scroll owner changes with width. While the narrow-width CSS override
    // was dead the article kept scrolling by accident, which kept the
    // persistence code working; fixing the cascade exposed that the JS had
    // never followed. Scrolled to the end and reloaded, a reader here used to
    // silently land back at the top every time.
    await page.setViewportSize({ width: 650, height: 420 });
    await page.goto('/');
    await openSavedTrace(page);
    const stage = page.locator('.scroll-layout');
    const article = page.locator('.reading-column');
    await expect(article).toBeVisible();
    expect(await article.evaluate(n => getComputedStyle(n).overflowY)).toBe('visible');
    expect(await stage.evaluate(n => n.scrollHeight > n.clientHeight)).toBe(true);

    await stage.evaluate(n => { n.scrollTop = 150; });
    await expect.poll(() => stage.evaluate(n => n.scrollTop)).toBeGreaterThan(0);
    const saved = await stage.evaluate(n => n.scrollTop);
    await page.waitForTimeout(400);

    await page.reload();
    const restored = page.locator('.scroll-layout');
    await expect(page.locator('.reading-column')).toBeVisible();
    await expect.poll(() => restored.evaluate(n => n.scrollTop)).toBeCloseTo(saved, -1);
  });

  test('reading position survives a reload, measured on the element that scrolls', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 420 });
    await page.goto('/');
    await openSavedTrace(page);
    const column = page.locator('.reading-column');
    await column.evaluate(n => { n.scrollTop = 120; });
    await expect.poll(() => column.evaluate(n => n.scrollTop)).toBeGreaterThan(0);
    const saved = await column.evaluate(n => n.scrollTop);
    // The position is written behind a 200ms debounce, so a reload inside that
    // window legitimately loses it. Wait past the debounce and prove the
    // persisted value is what comes back.
    await page.waitForTimeout(400);

    await page.reload();
    const restored = page.locator('.reading-column');
    await expect(restored).toBeVisible();
    await expect.poll(() => restored.evaluate(n => n.scrollTop)).toBeCloseTo(saved, -1);
  });

  test('the down arrow reads on while text remains, and only then takes the next discovery', async ({ page }) => {
    // A short viewport guarantees the Scroll overflows, which is the case that
    // matters: pressing down mid-read must move the text, not the Scroll.
    await page.setViewportSize({ width: 1440, height: 420 });
    await page.goto('/');
    await openSavedTrace(page);
    const column = page.locator('.reading-column');
    await expect(column).toBeVisible();
    const title = await page.getByRole('heading', { level: 2 }).textContent();
    expect(await column.evaluate(n => n.scrollHeight > n.clientHeight)).toBe(true);

    await page.keyboard.press('ArrowDown');
    await expect.poll(() => column.evaluate(n => n.scrollTop)).toBeGreaterThan(0);
    expect(await page.getByRole('heading', { level: 2 }).textContent()).toBe(title);

    await page.keyboard.press('ArrowUp');
    await expect.poll(() => column.evaluate(n => n.scrollTop)).toBe(0);
    expect(await page.getByRole('heading', { level: 2 }).textContent()).toBe(title);

    // Scrolled to the end, the same key becomes next discovery.
    await column.evaluate(n => { n.scrollTop = n.scrollHeight; });
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => page.getByRole('heading', { level: 2 }).textContent()).not.toBe(title);
  });

  test('opening and closing the source rail never moves the sentence being read', async ({ page }) => {
    // A rail that flanks the stage holds its place. If the grid gains a track
    // on open, the whole stage re-centres and the reading column slides out
    // from under the eye mid-sentence -- the opposite of the deliberate,
    // unhurried reading this surface is for.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await openSavedTrace(page);
    const column = page.locator('.reading-column');
    await expect(column).toBeVisible();
    const before = await column.boundingBox();

    await page.getByRole('button', { name: /Open sources panel/ }).click();
    await expect(page.getByRole('link', { name: /Open source/ })).toBeVisible();
    const open = await column.boundingBox();

    await page.getByRole('button', { name: /Close sources panel/ }).click();
    await expect(page.getByRole('link', { name: /Open source/ })).toHaveCount(0);
    const after = await column.boundingBox();

    expect(before).not.toBeNull();
    expect(open!.x).toBeCloseTo(before!.x, 0);
    expect(open!.width).toBeCloseTo(before!.width, 0);
    expect(after!.x).toBeCloseTo(before!.x, 0);
  });

  for (const viewport of viewports) {
    test(`end-of-library rest at ${viewport.name}: the finite three-asset editorial pool eventually empties`, async ({ page }) => {
      // A fresh page/context per viewport, not a reused one: a returning session restores its
      // last screen from storage on reload, so reusing one page across sizes would show the
      // previous iteration's Scroll instead of a fresh Universe.
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Your curiosity leaves a trace.' })).toBeVisible({ timeout: 15000 });
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
      await expect(page.getByRole('heading', { name: 'Your curiosity leaves a trace.' })).toBeVisible();
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
    await expect(page.getByRole('heading', { name: 'Your curiosity leaves a trace.' })).toBeVisible();
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
    await expect(page.getByRole('heading', { name: 'Your curiosity leaves a trace.' })).toBeVisible();
    await page.screenshot({ path: join(screenshotsDir, 'universe-reduced-motion-1440x900.png'), fullPage: true });

    await openSavedTrace(page);
    await page.screenshot({ path: join(screenshotsDir, 'reader-reduced-motion-1440x900.png'), fullPage: true });
  });

  test('keyboard-only pass: tab through every control, focus visible', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Your curiosity leaves a trace.' })).toBeVisible();
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
