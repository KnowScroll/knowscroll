import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import scaleChart from '@knowscroll/scroll-model/fixtures/scale-chart-blocks-ci.json';
import sortFork from '@knowscroll/scroll-model/fixtures/sort-fork-blocks-ci.json';
import type { ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { encounterFixture, readCover } from './encounter-fixture';

/**
 * The play blocks of D-207 (a sort, a fork, a scale, a growing chart, a guide) in the production export:
 * each played in the Folio essay over the labelled CI fixtures `*-blocks-ci` (not product
 * content). It proves what the client does, not the backend: every block works by keyboard-reachable
 * controls, has a text version, nothing is sent while it is played (the recorder gets no interaction),
 * and axe finds nothing serious at phone and desktop widths, under reduced motion too. With
 * `KS_BLOCK_SHOTS=<directory>` it also saves a screenshot of every block, to be read beside pages 7 and
 * 8 of the V3 Scrolls design.
 */

const sizes = [
  ['phone', { width: 390, height: 844 }],
  ['desktop', { width: 1440, height: 900 }],
] as const;

async function open(page: Page, document: unknown, viewport: { width: number; height: number }) {
  await encounterFixture(page, 'scroll', {
    viewport,
    scrollDocument: document as Record<string, unknown>,
  });
  await page.goto('/explore');
  await readCover(page);
  // The offer's own title heads the Scroll in the bar and again in the essay.
  await expect(
    page.getByTestId('reader-top-title').getByRole('heading', { level: 1, name: 'CI encounter fixture 1' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Got it' }).click();
}

/**
 * Brings a stop to the top of the reading band (42 % down the scroller), where it is the stop being read. Folio draws
 * every block inside the essay, so a block is reached by scrolling to the beat it belongs to.
 */
async function goTo(page: Page, stopId: string) {
  await page.getByTestId('folio-scroller').evaluate((node, id) => {
    const beat = node.querySelector(`[data-ks-stop="${id}"]`);
    if (beat === null) throw new Error(`no stop ${id}`);
    const band = Math.round(node.clientHeight * 0.42);
    node.scrollTop += beat.getBoundingClientRect().top - node.getBoundingClientRect().top - band + 1;
  }, stopId);
}

async function audit(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(' | ')}`);
}

async function shot(page: Page, size: string, label: string) {
  const directory = process.env['KS_BLOCK_SHOTS'];
  if (directory !== undefined && directory !== '') await page.screenshot({ path: `${directory}/${size}-${label}.png` });
}

/**
 * Every request that is not a GET while a block is being played. Playing sends nothing (D-209), so the list
 * stays empty: the window is the play only, so the recorder's own reading reports, which follow the stop
 * on screen, are not mistaken for play.
 */
function watchPlay(page: Page) {
  const sent: string[] = [];
  let playing = false;
  page.on('request', (request) => {
    if (playing && request.method() !== 'GET') sent.push(`${request.method()} ${request.url()}`);
  });
  return {
    sent,
    async during(play: () => Promise<void>) {
      playing = true;
      try {
        await play();
        // A request caused by the play would be sent within moments of it.
        await page.waitForTimeout(400);
      } finally {
        playing = false;
      }
    },
  };
}

for (const [size, viewport] of sizes) {
  for (const reduced of [false, true]) {
    const mode = reduced ? `${size}, reduced motion` : size;

    test(`sort, fork and guide at ${mode}: played on the device, with a text version and no axe findings`, async ({
      page,
    }) => {
      const errors: string[] = [];
      const watch = watchPlay(page);
      page.on('pageerror', (error) => errors.push(error.message));
      if (reduced) await page.emulateMedia({ reducedMotion: 'reduce' });
      await open(page, sortFork, viewport);

      await goTo(page, 'chain');
      await expect(page.getByTestId('play-sort')).toBeVisible();
      await shot(page, mode, 'sort');
      expect(await audit(page), 'sort').toEqual([]);
      await watch.during(async () => {
        // By keyboard: a card moved to either end keeps the focus on an arrow of the same card.
        const arrow = page.getByRole('button', { name: /^Move ".*" (up|down)$/u });
        const focused = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '');
        const lastDown = page.getByRole('button', { name: /^Move ".*" down$/u }).nth(2);
        await lastDown.focus();
        await page.keyboard.press('Enter');
        const atBottom = await focused();
        expect(atBottom, 'focus stays on an arrow after a card reaches the bottom').toMatch(/^Move ".*" (up|down)$/u);
        await page.keyboard.press('Enter');
        expect(await focused(), 'a press at the end does nothing and keeps focus').toBe(atBottom);
        const firstUp = page.getByRole('button', { name: /^Move ".*" up$/u }).nth(1);
        await firstUp.focus();
        await page.keyboard.press('Enter');
        expect(await focused(), 'focus stays on an arrow after a card reaches the top').toMatch(
          /^Move ".*" (up|down)$/u,
        );
        expect(await arrow.count()).toBe(8);
        await page.getByRole('button', { name: 'Check order' }).click();
        await expect(page.getByTestId('sort-close')).toBeVisible();
        await page.getByRole('button', { name: 'Show the order' }).click();
        await expect(page.getByTestId('sort-answer').first()).toBeVisible();
        await expect(page.getByTestId('sort-explain')).toBeVisible();
        await shot(page, mode, 'sort-shown');
        await page.getByRole('button', { name: 'Text version of the sort' }).click();
        await expect(page.getByTestId('sort-answer').first()).toBeVisible();
      });

      await goTo(page, 'ray');
      await expect(page.getByTestId('guide').first()).toBeVisible();
      await shot(page, mode, 'guide');
      expect(await audit(page), 'guide').toEqual([]);

      await goTo(page, 'paths');
      await expect(page.getByTestId('play-fork')).toBeVisible();
      await shot(page, mode, 'fork');
      await watch.during(async () => {
        await page.getByRole('button', { name: 'Path: The north' }).click();
        await expect(page.getByTestId('fork-branch')).toContainText('The north warms');
        await shot(page, mode, 'fork-chosen');
      });
      expect(await audit(page), 'fork').toEqual([]);
      await watch.during(async () => {
        await page.getByRole('button', { name: 'Text version of the fork' }).click();
        await expect(page.getByTestId('fork-text')).toContainText('The south cools');
      });

      expect(watch.sent).toEqual([]);
      expect(errors).toEqual([]);
    });

    test(`scale and growing chart at ${mode}: zoom and step, with a text version and no axe findings`, async ({
      page,
    }) => {
      const errors: string[] = [];
      const watch = watchPlay(page);
      page.on('pageerror', (error) => errors.push(error.message));
      if (reduced) await page.emulateMedia({ reducedMotion: 'reduce' });
      await open(page, scaleChart, viewport);

      await goTo(page, 'where');
      await expect(page.getByTestId('play-scale')).toBeVisible();
      await shot(page, mode, 'scale');
      expect(await audit(page), 'scale').toEqual([]);
      await watch.during(async () => {
        await page.getByRole('button', { name: 'Zoom out to Sarn' }).click();
        await expect(page.getByRole('button', { name: 'Zoom out to Sarn' })).toHaveAttribute('aria-pressed', 'true');
        await shot(page, mode, 'scale-zoomed');
        await page.getByRole('button', { name: 'Text version of the scale' }).click();
        await expect(page.getByTestId('scale-text')).toContainText('Orrin: 120 million km');
        await page.getByRole('button', { name: 'Text version of the scale' }).click();
      });

      await goTo(page, 'ray');
      await shot(page, mode, 'guide-point');

      await goTo(page, 'count');
      await expect(page.getByTestId('play-chart')).toBeVisible();
      await shot(page, mode, 'chart');
      await watch.during(async () => {
        await page.getByRole('button', { name: 'Show the next point' }).click();
        await expect(page.getByTestId('chart-readout')).toContainText('100 crates: 10,000 trips');
        await page.getByRole('button', { name: 'Show the next point' }).click();
        await shot(page, mode, 'chart-grown');
      });
      expect(await audit(page), 'chart').toEqual([]);
      await watch.during(async () => {
        await page.getByRole('button', { name: 'Text version of the chart' }).click();
        await expect(page.getByTestId('chart-text')).toContainText('1,000 crates: 1,000,000 trips');
      });

      expect(watch.sent).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
}

test('the T key swaps every block for its text version', async ({ page }) => {
  await open(page, sortFork, sizes[0][1]);
  await goTo(page, 'paths');
  await page.getByRole('group', { name: 'Scroll reader' }).focus();
  await page.keyboard.press('t');
  await expect(page.getByTestId('fork-text')).toBeVisible();
});

test('Simpler swaps only the stop’s own text: the play block and the guide stay (D-244)', async ({ page }) => {
  const doc = sortFork as unknown as ScrollDocumentV2;
  await open(page, sortFork, { width: 390, height: 844 });
  for (const [stopId, kept] of [
    ['chain', 'play-sort'],
    ['ray', 'guide'],
  ] as const) {
    await goTo(page, stopId);
    const stop = page.locator(`[data-ks-stop="${stopId}"]`);
    const simple = (doc.stops.find((candidate) => candidate.id === stopId) as { simple: string }).simple;
    // The stop has no link of its own (D-429): Shift + S is the keyboard's way to its plainer words, and back.
    await expect(stop.getByRole('button', { name: 'Say it simpler' })).toHaveCount(0);
    await page.getByRole('group', { name: 'Scroll reader' }).focus();
    // The reader takes the scroll in a moment after it: press until the stop that was jumped to is the one being read.
    await expect(async () => {
      await page.keyboard.press('Shift+S');
      await expect(stop.getByText(simple)).toBeVisible({ timeout: 1_000 });
    }).toPass();
    await expect(stop.getByTestId(kept).first()).toBeVisible();
    await expect(async () => {
      await page.keyboard.press('Shift+S');
      await expect(stop.getByText(simple)).toHaveCount(0, { timeout: 1_000 });
    }).toPass();
    await expect(stop.getByText(simple)).toHaveCount(0);
    await expect(stop.getByTestId(kept).first()).toBeVisible();
  }
});
