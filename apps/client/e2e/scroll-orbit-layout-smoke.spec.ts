import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import {
  describeStageState,
  settleStageState,
  type ScrollDocumentV2,
  type StageFigure,
  type StageState,
} from '@knowscroll/scroll-model';
import { encounterFixture } from './encounter-fixture';

/**
 * The orbit pictures of the Earth & sky kit, drawn as figures of the Folio essay in the production export over the labelled
 * `seasons-stage-ci` fixture (not product content) with distances added to its orbit stops, as a cited passage would state
 * them (D-382): the months' names, the pale Earths, the Earth of the month, the Sun, its words and the numbered Earths of the
 * recap stand clear of each other at a phone, a tablet and a desktop (D-393), and the tilt slider under the Final call's
 * figure sits clear of it. `earth-sky-orbit-layout.test.ts` proves it for every month; this proves the drawing follows it.
 * Screenshots are written only when `KS_FIDELITY_SHOTS` names a folder (outside the repository).
 */
const FIGURES: StageFigure[] = [
  { slot: 'nearest', value: 91_400_000, unit: 'miles' },
  { slot: 'farthest', value: 94_500_000, unit: 'miles' },
];
const viewports = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
] as const;

/** The labelled fixture with distances on its orbit stops, and the stretched stop standing at `month`. */
function withDistances(month: StageState['earthAt']): ScrollDocumentV2 {
  const document = structuredClone(seasons) as unknown as ScrollDocumentV2;
  // The Seasons fixture is an Earth & sky document, so every state of its stage is one of that kit's.
  for (const entry of document.stage?.states ?? []) {
    const before = entry.state as unknown as StageState;
    if (before.view !== 'orbit' && before.view !== 'orbit-stretched') continue;
    const state = settleStageState({
      ...before,
      earthAt: before.view === 'orbit-stretched' ? month : before.earthAt,
      figures: FIGURES,
    });
    Object.assign(entry, { state, alt: describeStageState(state) });
  }
  return document;
}

async function shot(page: Page, name: string) {
  const folder = process.env['KS_FIDELITY_SHOTS'];
  if (folder === undefined) return;
  mkdirSync(folder, { recursive: true });
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(folder, `${name}.png`) });
}

async function open(page: Page, document: ScrollDocumentV2, viewport: { width: number; height: number }) {
  await encounterFixture(page, 'scroll', {
    series: true,
    viewport,
    scrollDocument: document as unknown as Record<string, unknown>,
  });
  await page.goto('/explore');
  // The offer's own title heads the Scroll in the bar and again in the essay.
  await expect(
    page.getByTestId('reader-top-title').getByRole('heading', { level: 1, name: 'CI encounter fixture 1' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Got it' }).click();
}

const scroller = (page: Page) => page.getByTestId('folio-scroller');

/** The figure that draws the state a stop sets: a figure's key is the stop that set its state. */
const figureOf = (page: Page, stopId: string) => page.locator(`[data-ks-figure="${stopId}"]`);

interface Rect {
  readonly name: string;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/** The box on the page of every drawn thing the selector finds. */
async function boxes(figure: Locator, selector: string): Promise<Rect[]> {
  return figure.locator(selector).evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect();
      const name = node.getAttribute('data-testid') ?? node.textContent ?? '';
      // A line of text is boxed by its font's line height, which is taller than its letters: two stacked lines that
      // do not touch would still share a pixel row, so a line is measured by the body of its letters.
      const trim = node instanceof SVGTextElement ? box.height * 0.2 : 0;
      return { name, left: box.left, right: box.right, top: box.top + trim, bottom: box.bottom - trim };
    }),
  );
}

const overlap = (first: Rect, second: Rect): boolean =>
  first.left < second.right && second.left < first.right && first.top < second.bottom && second.top < first.bottom;

/** Pairs from `first` and `second` (or within `first` alone) that share some area. */
function collisions(first: readonly Rect[], second: readonly Rect[] = first): string[] {
  const same = first === second;
  return first.flatMap((one, at) =>
    (same ? second.slice(at + 1) : second)
      .filter((other) => overlap(one, other))
      .map((other) => `"${one.name}" covers "${other.name}"`),
  );
}

async function audit(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(' | ')}`);
}

/**
 * Scrolls the essay until the beat of a stop is the one being read, its top at the top of the reading band (42 % down the
 * screen), where a held figure has taken the beat's state; the figure of the stop is then drawn.
 */
async function showStop(page: Page, stopId: string): Promise<Locator> {
  await scroller(page).evaluate((node, id) => {
    const beat = node.querySelector(`[data-testid="beat-${id}"]`);
    if (beat === null) throw new Error(`no beat ${id}`);
    const band = Math.round(node.clientHeight * 0.42);
    node.scrollTop += beat.getBoundingClientRect().top - node.getBoundingClientRect().top - band + 1;
  }, stopId);
  const figure = figureOf(page, stopId);
  await expect(figure).toHaveCount(1);
  // The picture has settled once no move is under way: the motion token's 320 ms, with room to spare.
  await page.waitForTimeout(500);
  return figure;
}

/** Everything the orbit view draws that must not overlap another thing, measured on the page. */
async function expectOrbitClear(figure: Locator, where: string) {
  const words = await boxes(figure, '[data-testid^="orbit-month-"], [data-testid="stage-distances"] text');
  const earths = await boxes(figure, '[data-testid^="orbit-pale-earth-"], [data-testid="orbit-earth-now"]');
  const sun = await boxes(figure, '[data-testid="orbit-sun"]');
  expect(words.length, `${where}: the names and the words are drawn`).toBeGreaterThanOrEqual(5);
  expect(earths.length).toBeGreaterThanOrEqual(2);
  expect(collisions(words), `${where}: words`).toEqual([]);
  expect(collisions(words, earths), `${where}: words over Earths`).toEqual([]);
  expect(collisions(words, sun), `${where}: words over the Sun`).toEqual([]);
  expect(collisions(earths), `${where}: Earths`).toEqual([]);
  const frame = (await figure.boundingBox())!;
  for (const word of words) {
    expect(word.left, `${where}: "${word.name}"`).toBeGreaterThanOrEqual(frame.x);
    expect(word.right, `${where}: "${word.name}"`).toBeLessThanOrEqual(frame.x + frame.width);
  }
}

for (const viewport of viewports) {
  const size = `${String(viewport.width)}x${String(viewport.height)}`;

  test(`the orbit views set every Earth, name and word clear of each other, at ${size}`, async ({ page }) => {
    const document = withDistances('jan');
    await open(page, document, viewport);
    // The plain orbit in June, then the stretched orbit in January with its distances.
    const plain = await showStop(page, 'same-direction');
    await expectOrbitClear(plain, `${size} plain orbit, June`);
    await shot(page, `orbit-plain-${size}`);
    const stretched = await showStop(page, 'closest-in-january');
    await expect(stretched.getByText('SUN NOT TO SCALE')).toBeVisible();
    await expect(stretched.getByText('YOU ARE HERE · JAN')).toBeVisible();
    await expectOrbitClear(stretched, `${size} stretched orbit, January`);
    await shot(page, `orbit-stretched-${size}`);
    expect(await audit(page)).toEqual([]);
  });

  test(`the recap numbers every Earth with a badge that covers no Earth and no other badge, at ${size}`, async ({
    page,
  }) => {
    const document = withDistances('jan');
    await open(page, document, viewport);
    await page.getByRole('group', { name: 'Scroll reader' }).focus();
    await page.keyboard.press('End');
    const recap = page.getByTestId('end-figure');
    await expect(recap).toBeInViewport();
    const bodies = await boxes(recap, '[data-testid^="recap-earth-body-"]');
    const badges = await boxes(recap, '[data-testid^="recap-badge-"]');
    expect(bodies).toHaveLength(3);
    expect(badges).toHaveLength(3);
    expect(collisions(bodies), `${size}: Earths`).toEqual([]);
    expect(collisions(badges), `${size}: badges`).toEqual([]);
    expect(collisions(badges, bodies), `${size}: badges over Earths`).toEqual([]);
    await shot(page, `recap-orbit-${size}`);
  });
}

for (const month of ['feb', 'apr', 'jul', 'aug', 'oct', 'nov', 'dec', 'sep'] as const) {
  test(`the stretched orbit in ${month} lays out as clear as in January, at 390`, async ({ page }) => {
    const document = withDistances(month);
    await open(page, document, viewports[1]);
    const stretched = await showStop(page, 'closest-in-january');
    await expectOrbitClear(stretched, `stretched orbit, ${month}`);
  });
}

for (const viewport of viewports) {
  const size = `${String(viewport.width)}x${String(viewport.height)}`;

  test(`under the Final call's figure the tilt slider sits clear of it, and the orbit stays clear at every tilt, at ${size}`, async ({
    page,
  }) => {
    await open(page, withDistances('jan'), viewport);
    const plate = page.getByTestId('figure-figure-final-tilt');
    await plate.scrollIntoViewIfNeeded();
    const figure = plate.locator('[data-ks-figure]');
    const slider = page.getByRole('slider', { name: 'Earth’s tilt' });
    await expect(slider).toBeVisible();
    const drawn = (await figure.boundingBox())!;
    const control = (await slider.boundingBox())!;
    expect(control.y, `${size}: the slider is under the figure`).toBeGreaterThanOrEqual(drawn.y + drawn.height - 1);
    expect(control.x, `${size}: the slider is inside the screen`).toBeGreaterThanOrEqual(0);
    expect(control.x + control.width, `${size}: the slider is inside the screen`).toBeLessThanOrEqual(viewport.width);
    await expectOrbitClear(figure, `${size} orbit at today's tilt`);
    // Turned flat and then right over, the picture is redrawn at once, and its words still stand clear.
    await slider.focus();
    for (const [key, degrees] of [
      ['Home', '0°'],
      ['End', '90°'],
    ] as const) {
      await page.keyboard.press(key);
      await expect(page.getByTestId('tilt-value')).toHaveText(degrees);
      await expectOrbitClear(figure, `${size} orbit at ${degrees}`);
    }
    expect(await audit(page)).toEqual([]);
  });
}
