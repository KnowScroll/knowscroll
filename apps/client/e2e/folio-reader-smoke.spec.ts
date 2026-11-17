import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import type { ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { encounterFixture } from './encounter-fixture';
import { exportCarries } from './export-files';

/**
 * Folio, the essay reader of a v2 Scroll, in the production export (#732). It is opt-in by a device preference, so these
 * open a Scroll with that preference set and prove that Folio draws instead of the Stage reader, what it reports to the
 * recorder, the ••• sheet and Next idea, the page staying printed Light in both appearances, and that nothing changes
 * for a device that has not chosen it. The document is the labelled CI fixture `seasons-stage-ci` served by authored
 * HTTP fixtures, so this proves the reader and what it reports, not the backend. Screenshots are written only when
 * `KS_FOLIO_SHOTS` names a folder (outside the repository).
 */

const fixture = seasons as unknown as ScrollDocumentV2;
const phone = { width: 390, height: 844 };
const desktop = { width: 1440, height: 900 };
const KEY = 'ks.device.preferences';
const stopIds = fixture.stops.map((stop) => stop.id);

type Viewport = { width: number; height: number };

async function shot(page: Page, name: string) {
  const folder = process.env['KS_FOLIO_SHOTS'];
  if (folder === undefined) return;
  mkdirSync(folder, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(folder, `${name}.png`) });
}

async function audit(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(' | ')}`);
}

/** What this device has chosen, before the app reads it. `null` leaves the device as a fresh install. */
async function choose(page: Page, preferences: Record<string, unknown> | null) {
  if (preferences === null) return;
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [KEY, JSON.stringify(preferences)] as const,
  );
}

/** Opens Explore on the seasons Scroll as a person who chose Folio (or, with `null`, who chose nothing). */
async function open(
  page: Page,
  viewport: Viewport = phone,
  preferences: Record<string, unknown> | null = { scrollReader: 'folio', appearance: 'light' },
) {
  await choose(page, preferences);
  const served = await encounterFixture(page, 'scroll', {
    series: true,
    viewport,
    scrollDocument: seasons as unknown as Record<string, unknown>,
  });
  await page.goto('/explore');
  // The offer's own title heads the Scroll in the bar, whichever reader draws it.
  await expect(
    page.getByTestId('reader-top-title').getByRole('heading', { level: 1, name: 'CI encounter fixture 1' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Got it' }).click();
  return served;
}

const folio = (page: Page) => page.getByTestId('folio-page');
const scroller = (page: Page) => page.getByTestId('folio-scroller');
const reader = (page: Page) => page.getByRole('group', { name: 'Scroll reader' });
const navigations = (commands: { path: string; body: Record<string, unknown> }[]) =>
  commands.filter((call) => call.path === '/v1/experience/navigate').map((call) => call.body.intent);

const stopsOnPage = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-ks-stop]')]
      .map((node) => node.getAttribute('data-ks-stop') ?? '')
      .filter((id) => id !== 'end'),
  );

for (const [label, viewport] of [
  ['phone', phone],
  ['desktop', desktop],
] as const) {
  test(`with Folio chosen, the essay draws instead of the Stage reader, with its bar and dock, at ${label}`, async ({
    page,
  }) => {
    await open(page, viewport);
    await expect(folio(page)).toBeVisible();
    await expect(page.getByTestId('stage')).toHaveCount(0);
    // No spine: its dots are the Stage reader's.
    await expect(page.getByRole('button', { name: /^(Stop \d+ of|Call it \d+ of|Final call)/ })).toHaveCount(0);
    await expect(scroller(page).getByRole('heading', { level: 1, name: 'CI encounter fixture 1' })).toBeVisible();
    // The top bar and the dock are the app's own.
    await expect(page.getByRole('button', { name: 'Ask about this' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'More', exact: true })).toBeVisible();
    await expect(page.getByRole('progressbar', { name: 'How far you have read' })).toBeVisible();
    // The beats are the document's stops, once each, in order; a call is text.
    expect(await stopsOnPage(page)).toEqual(stopIds);
    await expect(scroller(page).getByRole('radio')).toHaveCount(0);
    await expect(scroller(page).getByRole('button', { name: 'Lock it in' })).toHaveCount(0);
    await shot(page, `explore-${label}`);
  });
}

/** Block ids and their intervals from every coverage event the page sent. */
function coverage(observed: { kind: string; payload: Record<string, unknown> }[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const event of observed) {
    if (event.kind !== 'scroll.block_coverage') continue;
    const blocks = event.payload.blocks as { blockId: string; intervalsMs: [number, number][] }[];
    for (const block of blocks)
      totals.set(
        block.blockId,
        (totals.get(block.blockId) ?? 0) +
          block.intervalsMs.reduce((sum: number, [from, to]: [number, number]) => sum + (to - from), 0),
      );
  }
  return totals;
}

test('reading the essay reaches the recorder as coverage of the document’s own stops, and nothing is an interaction', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.clock.install();
  const { observed } = await open(page);
  const most = await scroller(page).evaluate((node) => node.scrollHeight - node.clientHeight);
  // Read it through in small steps, with time passing while each step is on screen.
  for (let top = 0; top <= most; top += 120) {
    await scroller(page).evaluate((node, value) => {
      node.scrollTop = value;
    }, top);
    // Real time, so the scroll is taken in and drawn before the fake clock moves on.
    await page.waitForTimeout(100);
    await page.clock.fastForward(1_500);
  }
  await scroller(page).evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await page.waitForTimeout(100);
  await page.clock.fastForward(1_500);
  await page.clock.fastForward(16_000);

  const readStops = fixture.stops.filter((stop) => stop.kind === 'read').map((stop) => stop.id);
  await expect
    .poll(() => readStops.filter((id) => (coverage(observed).get(id) ?? 0) === 0), { timeout: 15_000 })
    .toEqual([]);
  const covered = coverage(observed);
  expect(observed.some((event) => event.kind === 'scroll.block_coverage')).toBe(true);
  // Every id reported is a stop of the document (no figure, heading or hold id), and every read stop is among them.
  for (const id of covered.keys()) expect(stopIds, `reported ${id}`).toContain(id);
  for (const id of readStops) expect(covered.get(id) ?? 0, `read stop ${id}`).toBeGreaterThan(0);
  // Calls are drawn as text with nothing to do, so none is reported as played.
  expect(observed.filter((event) => event.kind === 'scroll.block_interaction')).toEqual([]);
});

test('the ••• button opens the More sheet with its rows, and Next idea on the end plate asks for the next topic', async ({
  page,
}) => {
  const { commands } = await open(page);
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'More' });
  await expect(dialog).toBeVisible();
  // The rows of every v2 reader's sheet (the Scroll has calls, a limits aside and a Simpler version).
  const titles = await page
    .getByTestId('more-list')
    .getByRole('listitem')
    .getByRole('button')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')));
  expect(titles).toEqual([
    'Save',
    'Share a moment',
    'Challenge a friend',
    'Text version',
    'Simpler (this screen)',
    'Small print',
    'Report',
  ]);
  await expect(page.getByTestId('more-text-version')).toBeVisible();
  await expect(page.getByTestId('more-simpler')).toBeVisible();
  await shot(page, 'more-sheet');
  // Text version draws every picture as its words.
  await page.getByTestId('more-text-version').click();
  await expect(page.getByRole('dialog', { name: 'More' })).toHaveCount(0);
  await expect(page.locator('[data-ks-figure] [role="img"]')).toHaveCount(0);
  await expect(page.locator('[data-ks-figure]').first()).toContainText(
    /The Sun is on the left and Earth is on the right/,
  );
  // Simpler swaps the beat being read for its plainer words.
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByTestId('more-simpler').click();
  await expect(page.getByTestId('simpler-text')).toBeVisible();

  // The end plate: the short version, a way on to Part 2, Next idea and Close.
  await reader(page).focus();
  await page.keyboard.press('End');
  const plate = page.getByTestId('end-plate');
  await expect(plate.getByText('The short version')).toBeInViewport();
  await expect(plate.getByRole('button', { name: /^Part 2 · / })).toBeVisible();
  await expect(plate.getByRole('button', { name: 'Close' })).toBeVisible();
  expect(navigations(commands)).toEqual([]);
  await plate.getByRole('button', { name: 'Next idea', exact: true }).click();
  await expect.poll(() => navigations(commands).length).toBe(1);
  expect(navigations(commands)[0]).toMatchObject({ mode: 'vertical', direction: 'next' });
  await expect(
    page.getByTestId('reader-top-title').getByRole('heading', { level: 1, name: 'CI encounter fixture 2' }),
  ).toBeVisible();
});

/** The printed page of Folio: cream, in Light and in Dark alike (the page stays printed Light in this pull request). */
const PAPER = 'rgb(255, 251, 240)';

for (const appearance of ['dark', 'light'] as const) {
  test(`in ${appearance} the page is the printed cream and the reader has no serious accessibility violation`, async ({
    page,
  }) => {
    await open(page, phone, { scrollReader: 'folio', appearance });
    await expect(folio(page)).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-ks-appearance')))
      .toBe(appearance);
    await expect(folio(page)).toHaveCSS('background-color', PAPER);
    expect(await audit(page), `axe in ${appearance}`).toEqual([]);
    await shot(page, `appearance-${appearance}`);
    // Down to the end plate, with the pictures as words: still clean.
    await reader(page).focus();
    await page.keyboard.press('t');
    await page.keyboard.press('End');
    await expect(page.getByTestId('end-plate').getByText('The short version')).toBeInViewport();
    expect(await audit(page), `axe at the end in ${appearance}`).toEqual([]);
  });
}

test('a device that has not chosen Folio gets the Stage reader: Folio is only a trial', async ({ page }) => {
  await open(page, phone, null);
  await expect(page.getByTestId('stage')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop 1 of 12, you are here' })).toBeVisible();
  await expect(page.getByTestId('folio-page')).toHaveCount(0);
  await expect(page.getByTestId('folio-scroller')).toHaveCount(0);
});

test('the production export carries no Folio gallery, and its address is not a page', async ({ page }) => {
  expect(exportCarries(join(__dirname, '..', 'dist'), 'ks-folio-gallery')).toBe(false);
  await page.goto('/gallery-folio');
  await expect(page.getByText("This page isn't here")).toBeVisible();
  await expect(page.getByTestId('ks-folio-gallery')).toHaveCount(0);
});
