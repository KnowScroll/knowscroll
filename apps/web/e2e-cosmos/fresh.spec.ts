import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '../e2e/support/origin.ts';
import {
  ARTIFACTS_DIR,
  CAPTIONS,
  allCanvases,
  canvasesOutsideOrigin,
  expectHitArea,
  expectInsideViewport,
  expectNoHorizontalScroll,
  expectOneLiveOpeningContext,
  expectOpeningContextsReleased,
  instrument,
  instrumentOrigin,
  originFlag,
  readOriginLog,
} from './support.ts';

/**
 * ADR-0049 §5, against a FRESH disposable stack (scripts/run-web-cosmos-preview.ts without --grow):
 * nothing is recorded, so a new browser is a first visit and the cosmic-origin opening plays over
 * the Universe. Every test gets its own browser context, so each one really is a first visit unless
 * it says otherwise. Nothing here Keeps a Scroll: one Keep would make every later test a returning
 * reader. Opening the seed records only an exposure, which does not change who is "new".
 */
test.use({ originSeen: false });

const overlay = (page: Page) => page.getByTestId('origin');
const appShell = (page: Page) => page.locator('.app-shell');
const seed = (page: Page) => page.getByRole('button', { name: /^A first possibility/ });
const caption = (page: Page) => overlay(page).locator('.origin-caption');

test.beforeEach(async ({ context }) => {
  await instrument(context);
});

/** The first visit has begun: overlay up, Universe sealed beneath it and already loaded. */
async function openingHasBegun(page: Page): Promise<void> {
  await page.goto('/');
  await expect(overlay(page)).toBeVisible();
  await expect(appShell(page)).toHaveAttribute('inert', '');
  // The live Universe is already there underneath (the seed is the opening's last-frame target).
  await expect(page.locator('[data-origin-target]')).toHaveCount(1);
}

async function expectHandedToUniverse(page: Page): Promise<void> {
  await expect(overlay(page)).toHaveCount(0);
  await expect(appShell(page)).not.toHaveAttribute('inert');
  await expect(page.getByRole('heading', { name: 'Somewhere new starts here.' })).toBeVisible();
  await expect(seed(page)).toBeVisible();
  await expect(seed(page)).toBeEnabled();
  expect(await originFlag(page)).toBe('seen');
}

test.describe('the cosmic-origin opening on a first visit (fresh universe)', () => {
  test('a first visit shows the opening over a live canvas, with Skip and Sound controls', async ({ page }) => {
    await openingHasBegun(page);
    await expect(overlay(page)).toHaveClass(/origin--playing/);
    const skip = overlay(page).getByRole('button', { name: 'Skip', exact: true });
    const sound = overlay(page).getByRole('button', { name: 'Sound off', exact: true });
    await expect(skip).toBeVisible();
    await expect(skip).toBeFocused();
    await expect(sound).toBeVisible();
    await expect(sound).toHaveAttribute('aria-pressed', 'false');
    await expect(overlay(page).locator('canvas.origin-canvas')).toHaveCount(1);
    await expect(overlay(page).locator('canvas.origin-canvas')).toBeVisible();
    // The opening draws into a real WebGL context of its own.
    await expect.poll(async () => (await readOriginLog(page)).glContexts).toBeGreaterThan(0);
    expectOneLiveOpeningContext(await readOriginLog(page));
    // Nothing is remembered while the opening plays, and its words come only near the end.
    expect(await originFlag(page)).toBeNull();
    await expect(overlay(page).getByRole('region', { name: 'Opening' })).toBeAttached();
    await expect(caption(page)).toHaveText('');
  });

  test('the whole opening plays, its captions in order, then hands over to the Universe and releases what it held', async ({ page }) => {
    test.setTimeout(120_000);
    await openingHasBegun(page);
    const universeCanvases = await canvasesOutsideOrigin(page);
    expect(universeCanvases.length, 'the Universe owns canvases of its own under the opening').toBeGreaterThan(0);
    const [attached] = (await readOriginLog(page)).events;
    expect(attached?.type).toBe('attach');

    // The first caption, then the second, while the opening is still on screen.
    await expect(caption(page)).toHaveText(CAPTIONS[0], { timeout: 40_000 });
    await page.screenshot({ path: join(ARTIFACTS_DIR, 'first-visit-desktop-1280x720.png') });
    await expect(caption(page)).toHaveText(CAPTIONS[1], { timeout: 10_000 });
    await expect(overlay(page)).toBeVisible();

    // ~28.4 s in all: then the overlay is gone and the Universe takes input.
    await expect(overlay(page)).toHaveCount(0, { timeout: 30_000 });
    await expectHandedToUniverse(page);

    const log = await readOriginLog(page);
    expect(log.captions.map(item => item.text)).toEqual([...CAPTIONS]);
    // The words come late in the story (timeline.ts places them at ~21 s and ~24 s).
    expect(log.captions[0]!.at - attached!.at).toBeGreaterThan(15_000);
    expect(log.captions[1]!.at).toBeGreaterThan(log.captions[0]!.at);
    const detached = log.events.find(event => event.type === 'detach');
    expect(detached, 'the opening detached').toBeDefined();
    expect(detached!.at - attached!.at, 'the opening ran its whole length').toBeGreaterThan(26_000);
    expect(log.events.filter(event => event.type === 'attach')).toHaveLength(1);

    // Released: no overlay, no opening canvas, exactly the Universe's own canvases, and the
    // opening's WebGL context given back.
    await expect(page.locator('[data-testid="origin"]')).toHaveCount(0);
    expect(await allCanvases(page)).toEqual(universeCanvases);
    expectOpeningContextsReleased(log);

    // The opening's last frame is the reader's real first possibility: it opens a Scroll.
    await seed(page).click();
    await expect(page.getByRole('article')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Keep this Scroll' })).toBeVisible();
  });

  test('Skip ends the opening at once and remembers it; a reload goes straight to the Universe', async ({ page }) => {
    await openingHasBegun(page);
    const universeCanvases = await canvasesOutsideOrigin(page);
    const sound = overlay(page).getByRole('button', { name: /^Sound (off|on)$/ });
    await sound.click();
    await expect(sound).toHaveAttribute('aria-pressed', 'true');
    await expect(sound).toHaveText('Sound on');
    await expect.poll(async () => (await readOriginLog(page)).audioStates.length).toBeGreaterThan(0);

    await overlay(page).getByRole('button', { name: 'Skip', exact: true }).click();
    await expect(overlay(page)).toHaveCount(0, { timeout: 1_000 });
    await expectHandedToUniverse(page);
    // Released at once: the opening's canvas and context, and its sound.
    expect(await allCanvases(page)).toEqual(universeCanvases);
    expectOpeningContextsReleased(await readOriginLog(page));
    await expect
      .poll(async () => (await readOriginLog(page)).audioStates.every(state => state === 'closed'), { timeout: 3_000 })
      .toBe(true);
    // Skipped before any words: none were shown.
    expect((await readOriginLog(page)).captions).toEqual([]);

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Somewhere new starts here.' })).toBeVisible();
    await expect(seed(page)).toBeVisible();
    await expect(appShell(page)).not.toHaveAttribute('inert');
    // Not merely gone by now: in the reloaded document it never attached at all.
    expect((await readOriginLog(page)).events).toEqual([]);
  });

  test('Replay plays the opening again from the Universe, and Escape ends it', async ({ page }) => {
    await openingHasBegun(page);
    await page.keyboard.press('Escape');
    await expectHandedToUniverse(page);

    const replay = page.getByRole('button', { name: 'Replay the opening' });
    await expect(replay).toBeVisible();
    await expect(replay).toHaveText('↺ Opening');
    await replay.click();
    await expect(overlay(page)).toBeVisible();
    await expect(overlay(page)).toHaveClass(/origin--playing/);
    await expect(appShell(page)).toHaveAttribute('inert', '');
    await expect(overlay(page).getByRole('button', { name: 'Skip', exact: true })).toBeFocused();
    await expect(overlay(page).locator('canvas.origin-canvas')).toHaveCount(1);

    await page.keyboard.press('Escape');
    await expectHandedToUniverse(page);
    const log = await readOriginLog(page);
    expect(log.events.map(event => event.type)).toEqual(['attach', 'detach', 'attach', 'detach']);
    expectOpeningContextsReleased(log, 2);
  });

  test.describe('under reduced motion', () => {
    test.use({ reducedMotion: 'reduce' });

    test('still frames advance with Next, each caption is reachable, and the last one enters the Universe', async ({ page }) => {
      await openingHasBegun(page);
      await expect(overlay(page)).toHaveClass(/origin--stills/);
      const next = overlay(page).getByRole('button', { name: 'Next', exact: true });
      await expect(next).toBeVisible();
      await expect(overlay(page).getByRole('button', { name: 'Skip', exact: true })).toBeVisible();
      await expect(overlay(page).getByRole('button', { name: 'Sound off', exact: true })).toBeVisible();
      // The stills are drawn by the same renderer, once each.
      await expect(overlay(page).locator('canvas.origin-canvas')).toHaveCount(1);

      // Press Next until the first caption is shown (the early stills carry no words). A still's
      // caption is set in an effect after the press renders, so let two frames pass before reading.
      const settle = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
      for (let i = 0; i < 6 && (await caption(page).innerText()).trim() !== CAPTIONS[0]; i++) {
        await next.click();
        await settle();
      }
      await expect(caption(page)).toHaveText(CAPTIONS[0]);
      // One press: the second caption. One more: the opening ends in the Universe.
      await next.click();
      await expect(caption(page)).toHaveText(CAPTIONS[1]);
      await expect(next).toBeVisible();
      await next.click();
      await expect(overlay(page)).toHaveCount(0, { timeout: 3_000 });
      await expectHandedToUniverse(page);
      const log = await readOriginLog(page);
      expect(log.captions.map(item => item.text)).toEqual([...CAPTIONS]);
      expectOpeningContextsReleased(log);
    });
  });

  test('without WebGL the CSS version still tells it in words and enters the Universe', async ({ page, context }) => {
    // The page asks for WebGL 2 (glkit.ts); this browser answers as one without WebGL would.
    await context.addInitScript(() => {
      const proto = HTMLCanvasElement.prototype as unknown as { getContext: (this: HTMLCanvasElement, ...args: unknown[]) => unknown };
      const getContext = proto.getContext;
      proto.getContext = function (this: HTMLCanvasElement, ...args: unknown[]) {
        return String(args[0]).includes('webgl') ? null : getContext.apply(this, args);
      };
    });
    await openingHasBegun(page);
    await expect(overlay(page)).toHaveClass(/origin--fallback/);
    await expect(overlay(page).locator('canvas')).toHaveCount(0);
    await expect(overlay(page).locator('.origin-fallback-cloud')).toBeVisible();
    await expect(overlay(page).getByRole('button', { name: 'Skip', exact: true })).toBeVisible();
    await expect(caption(page)).toHaveText(CAPTIONS[0], { timeout: 5_000 });
    await expect(caption(page)).toHaveText(CAPTIONS[1], { timeout: 6_000 });
    await expect(overlay(page)).toHaveCount(0, { timeout: 10_000 });
    await expectHandedToUniverse(page);
    // The Universe draws its sky with CSS too.
    await expect(page.locator('.universe-camera')).toHaveAttribute('data-sky-mode', 'css');
    const log = await readOriginLog(page);
    expect(log.captions.map(item => item.text)).toEqual([...CAPTIONS]);
    expect(log.glContexts).toBe(0);
  });

  test('in a Chromium launched without WebGL, the CSS version plays and enters the Universe', async ({ playwright, browserName, baseURL }) => {
    test.skip(browserName !== 'chromium', 'launches a separate Chromium with its 3D APIs disabled');
    const browser = await playwright.chromium.launch({ args: ['--disable-webgl', '--disable-3d-apis'] });
    try {
      const context = await browser.newContext({ baseURL });
      await context.addInitScript(instrumentOrigin);
      const page = await context.newPage();
      await openingHasBegun(page);
      await expect(overlay(page)).toHaveClass(/origin--fallback/);
      await expect(overlay(page).locator('canvas')).toHaveCount(0);
      await expect(caption(page)).toHaveText(CAPTIONS[0], { timeout: 5_000 });
      await expect(caption(page)).toHaveText(CAPTIONS[1], { timeout: 6_000 });
      await expect(overlay(page)).toHaveCount(0, { timeout: 10_000 });
      await expectHandedToUniverse(page);
      await expect(page.locator('.universe-camera')).toHaveAttribute('data-sky-mode', 'css');
      await seed(page).click();
      await expect(page.getByRole('article')).toBeVisible({ timeout: 15_000 });
    } finally {
      await browser.close();
    }
  });

  test.describe('on a phone (390 × 844, touch)', () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });

    test('controls and words stay inside the screen, with no sideways scroll', async ({ page }) => {
      test.setTimeout(90_000);
      await openingHasBegun(page);
      const skip = overlay(page).getByRole('button', { name: 'Skip', exact: true });
      const sound = overlay(page).getByRole('button', { name: 'Sound off', exact: true });
      for (const [control, what] of [[skip, 'Skip'], [sound, 'Sound']] as const) {
        await expectInsideViewport(page, control, what);
        await expectHitArea(control, what);
      }
      await expectNoHorizontalScroll(page, 'opening on a phone');

      await expect(caption(page)).toHaveText(CAPTIONS[0], { timeout: 40_000 });
      await expectInsideViewport(page, caption(page), 'the first caption');
      await expectNoHorizontalScroll(page, 'opening caption on a phone');
      await page.screenshot({ path: join(ARTIFACTS_DIR, 'first-visit-phone-390x844.png') });

      await skip.tap();
      await expectHandedToUniverse(page);
      await expectInsideViewport(page, seed(page), 'the seed');
      await expectNoHorizontalScroll(page, 'new Universe on a phone');
      await page.screenshot({ path: join(ARTIFACTS_DIR, 'new-universe-phone-390x844.png') });
    });
  });
});
