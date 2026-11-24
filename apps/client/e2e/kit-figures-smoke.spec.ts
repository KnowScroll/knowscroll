import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import blackHole from '@knowscroll/scroll-model/fixtures/black-hole-stage-ci.json';
import nerve from '@knowscroll/scroll-model/fixtures/nerve-stage-ci.json';
import starlight from '@knowscroll/scroll-model/fixtures/starlight-stage-ci.json';
import type { ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { encounterFixture, readCover } from './encounter-fixture';

/**
 * The drawing kits of D-194, D-201 and D-204 in the production export: each kit's figures in the Folio essay, over the
 * labelled CI fixtures `<kit>-stage-ci` (not product content) and authored HTTP fixtures. It proves what the
 * client does, not the backend: the figure of a state is there once its beat is read (set after the beat, or held while
 * the beats about it pass), it is named by the description of its state, a state is drawn without a script error, the
 * reduced-motion path cross-fades, and axe finds nothing at phone and desktop widths. With `KS_KIT_SHOTS=<directory>`
 * it also saves a screenshot of each state, to be read beside the kit page of the V3 design.
 */

const KITS = [
  ['nerve', nerve],
  ['starlight', starlight],
  ['black-hole', blackHole],
] as const;
const sizes = [
  ['phone', { width: 390, height: 844 }],
  ['desktop', { width: 1440, height: 900 }],
] as const;

async function open(page: Page, document: ScrollDocumentV2, viewport: { width: number; height: number }) {
  await encounterFixture(page, 'scroll', {
    viewport,
    scrollDocument: document as unknown as Record<string, unknown>,
  });
  await page.goto('/explore');
  await readCover(page);
  // The offer's own title heads the Scroll in the bar and again in the essay.
  await expect(
    page.getByTestId('reader-top-title').getByRole('heading', { level: 1, name: 'CI encounter fixture 1' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Got it' }).click();
}

const scroller = (page: Page) => page.getByTestId('folio-scroller');

/** The figure that draws the state a stop sets: a figure's key is the stop that set its state. */
const figureOf = (page: Page, stopId: string) => page.locator(`[data-ks-figure="${stopId}"]`);

/** What axe finds that is serious or critical, as the other reader checks judge it. */
async function audit(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(' | ')}`);
}

/**
 * Scrolls the essay until the beat of a stop is the one being read. A beat in a hold is read at the hold's reading line,
 * where its figure takes the beat's state: 30 % of the room under a figure pinned above the beats, or 30 % down the
 * screen when the figure is beside them (`readingLineOf`, `packages/ui/src/scroll/folio/hold-geometry.ts`). Its top is
 * set a few pixels above that line; held beats are spaced like any others (#769), so the next one is still below it.
 * Any other beat is set at the top of the reading band, 42 % down the screen. The page is then given the moment the
 * held figure needs to move.
 */
async function showState(page: Page, stopId: string) {
  await scroller(page).evaluate((node, id) => {
    const beat = node.querySelector(`[data-testid="beat-${id}"]`);
    if (beat === null) throw new Error(`no beat ${id}`);
    const held = beat.closest('[data-testid^="hold-"]')?.querySelector('[data-testid="held-figure"]');
    let line = Math.round(node.clientHeight * 0.42) - 1;
    if (held !== null && held !== undefined) {
      const figure = held.getBoundingClientRect();
      const pinned = figure.left >= beat.getBoundingClientRect().right ? 0 : figure.height;
      line = Math.floor(pinned + (node.clientHeight - pinned) * 0.3) - 4;
    }
    node.scrollTop += beat.getBoundingClientRect().top - node.getBoundingClientRect().top - line;
  }, stopId);
  // The picture has settled once no move is under way: the motion token's 320 ms, with room to spare.
  await page.waitForTimeout(500);
}

/** The hold a beat is read in, if it is one of the beats a figure is held beside while they pass. */
const holdOf = (page: Page, stopId: string) =>
  page.locator('[data-testid^="hold-"]').filter({ has: page.getByTestId(`beat-${stopId}`) });

/** The picture a hold pins: its one figure, which moves to the state of the beat being read. */
const heldFigureOf = (page: Page, stopId: string) =>
  holdOf(page, stopId).getByTestId('held-figure').locator('[data-ks-figure]');

for (const [name, fixture] of KITS) {
  const document = fixture as unknown as ScrollDocumentV2;
  const states = document.stage?.states ?? [];

  for (const [sizeName, viewport] of sizes) {
    test(`${name} at ${sizeName}: each figure is there once its beat is read, is named by its description, and axe finds nothing`, async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await open(page, document, viewport);
      for (const [index, entry] of states.entries()) {
        await showState(page, entry.stop);
        const figure = figureOf(page, entry.stop);
        await expect(figure.getByRole('img', { name: entry.alt, exact: true })).toBeVisible();
        const box = await figure.boundingBox();
        expect(box?.width ?? 0).toBeGreaterThan(300);
        // A held figure is one picture that moves to the state of the beat being read.
        if ((await holdOf(page, entry.stop).count()) > 0)
          await expect(heldFigureOf(page, entry.stop)).toHaveAttribute('data-ks-figure', entry.stop);
        const directory = process.env['KS_KIT_SHOTS'];
        if (directory !== undefined && directory !== '') {
          const label = `${name}-${sizeName}-${String(index + 1)}-${entry.stop}`;
          await page.screenshot({ path: `${directory}/${label}.png` });
          await figure.screenshot({ path: `${directory}/${label}-figure.png` });
        }
        if (index === 0 || index === states.length - 1) {
          expect(await audit(page), `${name} state ${entry.stop}`).toEqual([]);
        }
      }
      // Every figure on the page is a picture with a name for a screen reader.
      const names = await page
        .locator('[data-ks-figure] [role="img"]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label') ?? ''));
      expect(names.length).toBeGreaterThan(0);
      expect(names.every((alt) => alt !== '')).toBe(true);
      expect(errors).toEqual([]);
    });
  }

  test(`${name}: a figure’s Text chip replaces the picture with the sentences of the state`, async ({ page }) => {
    await open(page, document, sizes[0][1]);
    const entry = states[1];
    if (entry === undefined) throw new Error('the fixture has several states');
    await showState(page, entry.stop);
    await figureOf(page, entry.stop).getByRole('button', { name: 'Text version of this picture' }).click();
    await expect(figureOf(page, entry.stop).getByText(entry.alt, { exact: true })).toBeVisible();
    await expect(figureOf(page, entry.stop).getByRole('img')).toHaveCount(0);
  });

  test(`${name}: the T key turns every picture into the sentences of its state`, async ({ page }) => {
    await open(page, document, sizes[0][1]);
    const entry = states[1];
    if (entry === undefined) throw new Error('the fixture has several states');
    await expect(page.locator('[data-ks-figure] [role="img"]').first()).toBeVisible();
    await page.getByRole('group', { name: 'Scroll reader' }).focus();
    await page.keyboard.press('t');
    await expect(page.locator('[data-ks-figure] [role="img"]')).toHaveCount(0);
    await expect(figureOf(page, entry.stop).getByText(entry.alt, { exact: true })).toBeAttached();
  });

  test(`${name}: under reduced motion a move is a cross-fade, never a glide`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, document, sizes[0][1]);
    // Only a held figure moves from one state to another: the others are drawn once, where they are.
    const held: string[] = [];
    for (const entry of states) if ((await holdOf(page, entry.stop).count()) > 0) held.push(entry.stop);
    let crossfaded = false;
    for (const stop of held) {
      await showState(page, stop);
      const transition = await heldFigureOf(page, stop).getAttribute('data-ks-figure-transition');
      expect(transition, `held figure at ${stop}`).not.toBe('tween');
      crossfaded ||= transition === 'crossfade';
    }
    // Every kit fixture has at least one hold, so there is always a held figure that moves.
    expect(held.length, 'a hold in the kit').toBeGreaterThan(0);
    expect(crossfaded, 'the held figure fades from state to state').toBe(true);
    await expect(page.locator('[data-ks-figure-transition="tween"]')).toHaveCount(0);
  });
}
