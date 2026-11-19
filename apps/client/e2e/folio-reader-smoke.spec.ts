import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import type { ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { answerActions, type ActionsState } from './actions-fixture';
import { encounterFixture, readCover } from './encounter-fixture';
import { exportCarries } from './export-files';

/**
 * Folio, the essay reader of a v2 Scroll, in the production export (#732). These open a Scroll and prove that Folio
 * draws it, with a device that has chosen nothing included, what it reports to the recorder, the ••• sheet and Next
 * idea, and the page's own palette in each appearance. The document is the labelled CI fixture `seasons-stage-ci` served by authored
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

/** What this device has chosen, before the app reads it (Light, where a test reads the page's colours: a fresh install is Dark). `null` leaves the device as a fresh install. */
async function choose(page: Page, preferences: Record<string, unknown> | null) {
  if (preferences === null) return;
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [KEY, JSON.stringify(preferences)] as const,
  );
}

/** Opens Explore on the seasons Scroll as a person who chose Light (or, with `null`, who chose nothing). */
async function open(
  page: Page,
  viewport: Viewport = phone,
  preferences: Record<string, unknown> | null = { appearance: 'light' },
  actions?: ActionsState,
) {
  await choose(page, preferences);
  const served = await encounterFixture(page, 'scroll', {
    series: true,
    viewport,
    scrollDocument: seasons as unknown as Record<string, unknown>,
    ...(actions === undefined ? {} : { actions }),
  });
  await page.goto('/explore');
  await readCover(page);
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
  test(`the essay draws a v2 Scroll, with the reader's bar and dock, at ${label}`, async ({ page }) => {
    await open(page, viewport);
    await expect(folio(page)).toBeVisible();
    await expect(page.getByTestId('stage')).toHaveCount(0);
    // No spine of dots: the progress rail shows how far the reader is.
    await expect(page.getByRole('button', { name: /^(Stop \d+ of|Call it \d+ of|Final call)/ })).toHaveCount(0);
    await expect(scroller(page).getByRole('heading', { level: 1, name: 'CI encounter fixture 1' })).toBeVisible();
    // The top bar and the dock are the app's own.
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

const dockOf = (page: Page) => page.getByTestId('reader-dock');

test('the dock of a Scroll on arrival is Like, Share and Save, then ••• and Part 2, with Ask in •••', async ({
  page,
}) => {
  await open(page);
  const dock = dockOf(page);
  // Like and Save are toggle buttons (pressed or not); Share and ••• are plain buttons; the way on is the next Part.
  await expect(dock.getByRole('button', { name: 'Like', pressed: false })).toBeVisible();
  await expect(dock.getByRole('button', { name: 'Share a moment' })).toBeEnabled();
  await expect(dock.getByRole('button', { name: 'Save', pressed: false })).toBeVisible();
  await expect(dock.getByRole('button', { name: 'More', exact: true })).toBeVisible();
  await expect(dock.getByRole('button', { name: /^Part 2: / })).toBeVisible();
  await expect(dock.getByRole('button', { name: 'Ask about this' })).toHaveCount(0);
  // Left to right: Like, Share, Save, then •••, then the way on.
  const xs = await Promise.all(
    ['Like', 'Share a moment', 'Save', 'More', /^Part 2: /].map(async (name) => {
      const box = await dock.getByRole('button', { name }).boundingBox();
      return box!.x;
    }),
  );
  expect(xs).toEqual([...xs].sort((a, b) => a - b));
  // Each glyph carries its small visible word.
  for (const word of ['Like', 'Share', 'Save', 'More'])
    await expect(dock.getByText(word, { exact: true })).toBeVisible();
  expect(await audit(page)).toEqual([]);
});

test('Like toggles from its button and from L, keeps its word, and tells the feed once each way', async ({ page }) => {
  const state = { saved: false, liked: false, hidden: false };
  await open(page, phone, { appearance: 'light' }, state);
  const sent = await answerActions(page, state);
  const dock = dockOf(page);
  // A press is ignored while the one before is settling, so each step waits until the button is no longer busy.
  const settled = () => expect(dock.getByRole('button', { name: 'Like' })).not.toHaveAttribute('aria-busy', 'true');
  await dock.getByRole('button', { name: 'Like', pressed: false }).click();
  const liked = dock.getByRole('button', { name: 'Like', pressed: true });
  await expect(liked).toBeVisible();
  await settled();
  await expect(dock.getByText('Like', { exact: true })).toBeVisible();
  expect(sent.map((command) => command.kind)).toEqual(['like']);
  // The same control takes the like back, and L does the same from the keyboard.
  await liked.click();
  await expect(dock.getByRole('button', { name: 'Like', pressed: false })).toBeVisible();
  await settled();
  await reader(page).focus();
  await page.keyboard.press('l');
  await expect(dock.getByRole('button', { name: 'Like', pressed: true })).toBeVisible();
  expect(sent.map((command) => command.kind)).toEqual(['like', 'unlike', 'like']);
  // Nothing in the ••• sheet is a Like.
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await expect(page.getByTestId('more-list').getByRole('button', { name: /Like/ })).toHaveCount(0);
});

test('Save toggles from its button, keeps its word, and is no longer a row of •••', async ({ page }) => {
  const state = { saved: false, liked: false, hidden: false };
  await open(page, phone, { appearance: 'light' }, state);
  const sent = await answerActions(page, state);
  const dock = dockOf(page);
  await dock.getByRole('button', { name: 'Save', pressed: false }).click();
  await expect(dock.getByRole('button', { name: 'Save', pressed: true })).toBeVisible();
  await expect(dock.getByText('Save', { exact: true })).toBeVisible();
  expect(sent.map((command) => command.kind)).toEqual(['save']);
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await expect(page.getByTestId('more-save')).toHaveCount(0);
  await expect(page.getByTestId('more-share-moment')).toHaveCount(0);
});

test('Share is never a dead button: a moment where the stop can be one, the whole Scroll at the end', async ({
  page,
}) => {
  const served = await open(page);
  const dock = dockOf(page);
  await expect(dock.getByRole('button', { name: 'Share a moment' })).toBeEnabled();
  await reader(page).focus();
  await page.keyboard.press('End');
  await expect(page.getByTestId('end-plate').getByText('To sum up')).toBeInViewport();
  // The end is no stop to quote: the same button, its word unchanged, shares the Scroll and says so in its name.
  const share = dock.getByRole('button', { name: 'Share this Scroll' });
  await expect(share).toBeEnabled();
  await expect(dock.getByText('Share', { exact: true })).toBeVisible();
  await expect(dock.getByRole('button', { name: /^Share a moment/ })).toHaveCount(0);
  await share.click();
  await expect(
    page.getByRole('dialog', { name: 'Share' }).getByRole('button', { name: 'Send to a conversation' }),
  ).toBeVisible();
  // It is the sheet ••• then "Share this Scroll" opens, and no Share a moment sheet opened.
  await expect(page.getByRole('dialog', { name: 'Share a moment' })).toHaveCount(0);
  expect(navigations(served.commands)).toEqual([]);
});

test('Ask about this is the first row of •••, opens Ask at the stop on screen, and A still opens it directly', async ({
  page,
}) => {
  const served = await open(page);
  // Past the opening stop, so the anchor is the stop on screen and not just the first one. The reader learns where it is
  // a moment after the scroll, so a probe (Share a moment quotes the stop being read) is asked until it has.
  await scroller(page).evaluate((node) => {
    node.scrollTop = (node.scrollHeight - node.clientHeight) / 2;
  });
  await expect
    .poll(async () => {
      await reader(page).focus();
      await page.keyboard.press('h');
      const quote = await page.getByTestId('moment-quote').innerText();
      const probe = page.getByRole('dialog', { name: 'Share a moment' });
      await probe.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(probe).toHaveCount(0);
      return quote;
    })
    .not.toContain('It leans.');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const first = page.getByTestId('more-list').getByRole('button').first();
  await expect(first).toHaveAccessibleName('Ask about this');
  await expect(page.getByTestId('more-ask')).toContainText('A');
  await first.click();
  const sheet = page.getByRole('dialog', { name: 'Ask for something' });
  await expect(sheet).toBeVisible();
  // A question sent from here is anchored to the stop on screen, which is not the opening one.
  await sheet.getByRole('button', { name: `Ask: ${seasons.askSuggestions[0]}` }).click();
  const asked = () => served.commands.filter((command) => command.path === '/v1/content/requests');
  await expect.poll(() => asked().length).toBe(1);
  const { intent } = asked()[0]!.body as { intent: { anchor: { kind: string; stopId: string } } };
  expect(intent.anchor.kind).toBe('stop');
  expect(stopIds).toContain(intent.anchor.stopId);
  expect(intent.anchor.stopId).not.toBe(stopIds[0]);
  await page.getByTestId('ask-making').getByRole('button', { name: 'Keep reading' }).click();
  await expect(page.getByTestId('ask-making')).toHaveCount(0);
  // Escape closes the sheet; then A opens the same sheet with no ••• in between.
  await reader(page).focus();
  await page.keyboard.press('a');
  const again = page.getByRole('dialog', { name: 'Ask for something' });
  await expect(again).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(again).toHaveCount(0);
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
    'Ask about this',
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

  // The end plate: the summary, a way on to Part 2, Next idea and Close.
  await reader(page).focus();
  await page.keyboard.press('End');
  const plate = page.getByTestId('end-plate');
  await expect(plate.getByText('To sum up')).toBeInViewport();
  await expect(plate.getByRole('button', { name: /^Part 2 · / })).toBeVisible();
  await expect(plate.getByRole('button', { name: 'Close' })).toBeVisible();
  expect(navigations(commands)).toEqual([]);
  await plate.getByRole('button', { name: 'Next idea', exact: true }).click();
  await expect.poll(() => navigations(commands).length).toBe(1);
  expect(navigations(commands)[0]).toMatchObject({ mode: 'vertical', direction: 'next' });
  // The next topic is offered as a cover, and opens when it is read.
  await readCover(page);
  await expect(
    page.getByTestId('reader-top-title').getByRole('heading', { level: 1, name: 'CI encounter fixture 2' }),
  ).toBeVisible();
});

/** Folio's page ground in each appearance (D-424): the printed cream in Light, a warm near-black in Dark. */
const GROUND = { light: 'rgb(255, 251, 240)', dark: 'rgb(23, 21, 15)' } as const;
/** Its ink: near-black on cream, cream on the dark ground (never pure white). */
const INK = { light: 'rgb(17, 17, 17)', dark: 'rgb(234, 227, 208)' } as const;

for (const appearance of ['dark', 'light'] as const) {
  test(`in ${appearance} the page takes its own palette and the reader has no serious accessibility violation`, async ({
    page,
  }) => {
    await open(page, phone, { appearance });
    await expect(folio(page)).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-ks-appearance')))
      .toBe(appearance);
    await expect(folio(page)).toHaveCSS('background-color', GROUND[appearance]);
    await expect(folio(page).getByRole('heading', { level: 1 })).toHaveCSS('color', INK[appearance]);
    expect(await audit(page), `axe in ${appearance}`).toEqual([]);
    await shot(page, `appearance-${appearance}`);
    // Down to the end plate, with the pictures as words: still clean.
    await reader(page).focus();
    await page.keyboard.press('t');
    await page.keyboard.press('End');
    await expect(page.getByTestId('end-plate').getByText('To sum up')).toBeInViewport();
    expect(await audit(page), `axe at the end in ${appearance}`).toEqual([]);
  });
}

test('a device that has chosen nothing gets Folio, on the dark page', async ({ page }) => {
  await open(page, phone, null);
  await expect(folio(page)).toBeVisible();
  await expect(scroller(page)).toBeVisible();
  await expect(page.getByTestId('stage')).toHaveCount(0);
  await expect(folio(page)).toHaveCSS('background-color', GROUND.dark);
});

test('the production export carries no Folio gallery, and its address is not a page', async ({ page }) => {
  expect(exportCarries(join(__dirname, '..', 'dist'), 'ks-folio-gallery')).toBe(false);
  await page.goto('/gallery-folio');
  await expect(page.getByText("This page isn't here")).toBeVisible();
  await expect(page.getByTestId('ks-folio-gallery')).toHaveCount(0);
});

test('switching appearance in the middle of the essay repaints the page and keeps the place', async ({ page }) => {
  await open(page, phone, { appearance: 'dark' });
  await expect(folio(page)).toHaveCSS('background-color', GROUND.dark);
  const scroller = page.getByTestId('folio-scroller');
  await scroller.evaluate((node) => {
    node.scrollTop = node.scrollHeight / 2;
  });
  const before = await scroller.evaluate((node) => node.scrollTop);
  // The app names the appearance on the root (Account → Appearance does the same): the page follows at once.
  await page.evaluate(() => document.documentElement.setAttribute('data-ks-appearance', 'light'));
  await expect(folio(page)).toHaveCSS('background-color', GROUND.light);
  expect(await scroller.evaluate((node) => node.scrollTop)).toBe(before);
});
