import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import { encounterFixture, id, type EncounterFixtureOptions } from './encounter-fixture';

/**
 * Covers in Explore (#747) in the production export over labelled HTTP fixtures (no backend): behind the device switch
 * "Show Scrolls as covers (trial)", Explore deals a hand of covers and opens one only when asked. The hands, the covers
 * and the documents are authored in `encounter-fixture.ts`, so this proves what the page does with them, not what the
 * server chooses to deal.
 */

const phone = { width: 390, height: 844 };
const desktop = { width: 1440, height: 900 };
const small = { width: 320, height: 568 };
const document2 = seasons as unknown as Record<string, unknown>;
const HAND = 3;

type Calls = { path: string; body: Record<string, unknown> }[];
const callsTo = (commands: Calls, path: string) => commands.filter((call) => call.path === path);
const activations = (commands: Calls) => callsTo(commands, '/v1/experience/activate');
const opens = (commands: Calls) => callsTo(commands, '/v1/experience/open');

const cover = (page: Page) => page.getByTestId('essay-cover');
const coverTitle = (page: Page, n: number) =>
  cover(page).getByRole('heading', { level: 1, name: `CI encounter fixture ${String(n)}` });
const position = (page: Page, of: number) => cover(page).getByText(`${String(of)} OF ${String(HAND)}`, { exact: true });
const readerTitle = (page: Page, n: number) =>
  page.getByTestId('reader-top-title').getByRole('heading', { level: 1, name: `CI encounter fixture ${String(n)}` });

/** Whether a person pressing the middle of the control would press it, and not the tab bar or a note floating over it. */
const pressable = (control: Locator) =>
  control.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return top !== null && node.contains(top);
  });

/** Explore with covers on (or off, with `switchOn: false`), up to the first cover and past the first-arrival note. */
async function openCovers(
  page: Page,
  options: {
    readonly switchOn?: boolean;
    readonly preferences?: Record<string, unknown>;
    readonly viewport?: { width: number; height: number };
    readonly fixture?: EncounterFixtureOptions;
  } = {},
) {
  const switchOn = options.switchOn ?? true;
  const served = await encounterFixture(page, 'scroll', {
    covers: { hand: HAND },
    scrollDocument: document2,
    viewport: options.viewport ?? phone,
    devicePreferences: { ...(switchOn ? { coversInExplore: true } : {}), ...options.preferences },
    ...options.fixture,
  });
  await page.goto('/explore');
  if (switchOn) {
    await expect(cover(page)).toBeVisible();
    // A cover names its own moves (the arrows, Read, the strip), so no first-arrival note is laid over Read.
    await expect(page.getByRole('note', { name: 'How to move around' })).toHaveCount(0);
  }
  return served;
}

test('with the switch on, Explore arrives on a cover and opens nothing; it asked for covers', async ({ page }) => {
  const { commands } = await openCovers(page);
  await expect(coverTitle(page, 1)).toBeVisible();
  await expect(position(page, 1)).toBeVisible();
  await expect(cover(page).getByText('CI cover kicker 1', { exact: true })).toBeVisible();
  await expect(page.getByTestId('essay-cover-figure')).toBeVisible();
  await expect(page.getByTestId('essay-cover-read')).toBeVisible();
  // The strip is the way on at the foot of the cover: the floating tab bar must not sit over it.
  expect(await pressable(page.getByTestId('essay-cover-next'))).toBe(true);
  expect(await pressable(page.getByTestId('essay-cover-read'))).toBe(true);
  // Looking at a cover is not reading: nothing was activated, so nothing was recorded.
  await page.waitForTimeout(500);
  expect(activations(commands)).toHaveLength(0);
  expect(callsTo(commands, '/v1/observations/recording-batch')).toHaveLength(0);
  expect(opens(commands)).toHaveLength(1);
  expect(opens(commands)[0]?.body.capabilities).toMatchObject({
    documentSchemas: expect.arrayContaining(['offer-cover.v1']),
  });
});

test('↓, J and the strip turn to the next cover, ↑ and K back; after the last, one more open deals a new hand', async ({
  page,
}) => {
  const { commands } = await openCovers(page);
  await page.keyboard.press('ArrowDown');
  await expect(position(page, 2)).toBeVisible();
  await expect(coverTitle(page, 2)).toBeVisible();
  // The strip names the cover that comes next.
  await expect(page.getByTestId('essay-cover-next')).toContainText('CI encounter fixture 3');
  await page.getByTestId('essay-cover-next').click();
  await expect(position(page, 3)).toBeVisible();
  await expect(coverTitle(page, 3)).toBeVisible();
  await expect(page.getByTestId('essay-cover-next')).toContainText('MORE COVERS');
  await page.keyboard.press('ArrowUp');
  await expect(position(page, 2)).toBeVisible();
  await page.keyboard.press('k');
  await expect(position(page, 1)).toBeVisible();
  await expect(page.getByTestId('essay-cover-previous')).toHaveCount(0);
  await page.keyboard.press('j');
  await expect(position(page, 2)).toBeVisible();
  await page.getByTestId('essay-cover-down').click();
  await expect(position(page, 3)).toBeVisible();
  // Turning through a hand asks for nothing.
  expect(opens(commands)).toHaveLength(1);
  await page.keyboard.press('ArrowDown');
  await expect(coverTitle(page, 4)).toBeVisible();
  await expect(position(page, 1)).toBeVisible();
  // The next hand is a new open of discovery that resumes the session, and nothing was activated to get there.
  expect(opens(commands)).toHaveLength(2);
  expect(opens(commands)[1]?.body.target).toEqual({ kind: 'discover' });
  expect(activations(commands)).toHaveLength(0);
  // The new hand is a hand like the first: its second cover is the fifth Scroll.
  await page.keyboard.press('ArrowDown');
  await expect(coverTitle(page, 5)).toBeVisible();
});

test('Read opens the shown cover with one activation, in Folio; Back returns to that cover and Back again leaves the covers', async ({
  page,
}) => {
  const { commands } = await openCovers(page);
  await page.keyboard.press('ArrowDown');
  await expect(coverTitle(page, 2)).toBeVisible();
  await page.getByTestId('essay-cover-read').click();
  // Folio draws its title twice (the bar and the essay's head): the bar's is the one that names the Scroll.
  await expect(readerTitle(page, 2)).toBeVisible();
  await expect(page.getByTestId('folio-page')).toBeVisible();
  await expect(cover(page)).toHaveCount(0);
  expect(activations(commands)).toHaveLength(1);
  expect(activations(commands)[0]?.body.target).toMatchObject({ offerId: id(101) });

  await page.goBack();
  await expect(cover(page)).toBeVisible();
  await expect(coverTitle(page, 2)).toBeVisible();
  await expect(position(page, 2)).toBeVisible();
  // The hand is still the hand: the next cover is the third, and nothing was asked of the server to get here.
  await expect(page.getByTestId('essay-cover-next')).toContainText('CI encounter fixture 3');
  expect(opens(commands)).toHaveLength(1);
  expect(callsTo(commands, '/v1/experience/navigate')).toHaveLength(0);
  expect(activations(commands)).toHaveLength(1);

  // These covers were the first thing dealt, so there is no entry under them: Back is not Explore's to take and the
  // browser leaves the page.
  await page.goBack();
  await expect(page).not.toHaveURL(/\/explore$/);
  expect(activations(commands)).toHaveLength(1);
});

test('Enter on a cover opens it, and a tap on its title does too', async ({ page }) => {
  const { commands } = await openCovers(page);
  await page.keyboard.press('Enter');
  await expect(readerTitle(page, 1)).toBeVisible();
  expect(activations(commands)).toHaveLength(1);
  await page.goBack();
  await expect(coverTitle(page, 1)).toBeVisible();
  await coverTitle(page, 1).click();
  await expect(readerTitle(page, 1)).toBeVisible();
  // The same offer opened again is a second reading of it, opened by a second ask.
  expect(activations(commands)).toHaveLength(2);
  expect(activations(commands)[1]?.body.target).toMatchObject({ offerId: id(100) });
});

test.describe('a finger', () => {
  test.use({ hasTouch: true });

  test('swiping up on a cover turns to the next, swiping down to the one before; a short drag turns nothing', async ({
    page,
  }) => {
    const { commands } = await openCovers(page);
    const swipe = async (from: number, to: number) => {
      const box = await cover(page).boundingBox();
      if (!box) throw new Error('the cover is on the page');
      const x = box.x + box.width / 2;
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: box.y + from }] });
      for (let step = 1; step <= 6; step += 1)
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x, y: box.y + from + ((to - from) * step) / 6 }],
        });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    };
    await swipe(120, 150);
    await page.waitForTimeout(300);
    await expect(position(page, 1)).toBeVisible();
    await swipe(560, 300);
    await expect(position(page, 2)).toBeVisible();
    await expect(coverTitle(page, 2)).toBeVisible();
    await swipe(300, 560);
    await expect(position(page, 1)).toBeVisible();
    expect(activations(commands)).toHaveLength(0);
  });
});

test('with the switch off a Scroll opens on arrival as before', async ({ page }) => {
  // The server would send a cover; the page does not ask for one to be shown, and one Scroll activates.
  const off = await openCovers(page, { switchOn: false });
  await expect(readerTitle(page, 1)).toBeVisible();
  await expect(cover(page)).toHaveCount(0);
  expect(activations(off.commands)).toHaveLength(1);
});

test('with the switch on, an offer without a cover also opens on arrival', async ({ page }) => {
  // No `covers` in the fixture: the offers carry none, however the page asks.
  const { commands } = await encounterFixture(page, 'scroll', {
    scrollDocument: document2,
    devicePreferences: { coversInExplore: true },
  });
  await page.goto('/explore');
  await expect(readerTitle(page, 1)).toBeVisible();
  await expect(cover(page)).toHaveCount(0);
  expect(activations(commands)).toHaveLength(1);
});

test('with the switch on, a hand of Reels plays as before', async ({ page }) => {
  const { commands } = await encounterFixture(page, 'reel', {
    covers: { hand: HAND },
    devicePreferences: { coversInExplore: true },
  });
  await page.route('**/media/gesture-fixture', (route) =>
    route.fulfill({ status: 404, body: 'CI fixture only: no decoded playback claimed' }),
  );
  await page.goto('/explore');
  await expect(page.getByTestId('reel-navigation-stage')).toBeVisible();
  await expect(cover(page)).toHaveCount(0);
  expect(activations(commands)).toHaveLength(1);
});

async function seriousViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map(
      (violation) =>
        `${violation.id}: ${violation.nodes.map((node) => `${node.target.join(' ')} ${node.html.slice(0, 120)}`).join(' | ')}`,
    );
}

for (const [label, viewport] of [
  ['390x844', phone],
  ['1440x900', desktop],
] as const) {
  for (const appearance of ['light', 'dark'] as const) {
    test(`the cover feed has no serious accessibility violations in ${appearance} at ${label}`, async ({ page }) => {
      await openCovers(page, { viewport, preferences: { appearance } });
      await expect(page.getByTestId('essay-cover-figure')).toBeVisible();
      // The figure draws in as the cover arrives; axe would read it half drawn.
      await page.waitForTimeout(600);
      expect(await seriousViolations(page)).toEqual([]);
      // The second cover, whose strip names a next cover rather than more.
      await page.keyboard.press('ArrowDown');
      await expect(position(page, 2)).toBeVisible();
      await page.waitForTimeout(600);
      expect(await seriousViolations(page)).toEqual([]);
    });
  }
}

test('at 320 by 568 with the largest text the Read button and the strip are reachable and nothing is clipped across', async ({
  page,
}) => {
  await openCovers(page, { viewport: small, preferences: { textSize: 'largest' } });
  // The cover settles: its figure is not drawn and dropped again and again as it measures what is left for it.
  const settled = async () => {
    const tops: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      tops.push(Math.round((await page.getByTestId('essay-cover-read').boundingBox())?.y ?? -1));
      await page.waitForTimeout(100);
    }
    return new Set(tops).size;
  };
  expect(await settled()).toBe(1);
  const read = page.getByTestId('essay-cover-read');
  const strip = page.getByTestId('essay-cover-next');
  for (const control of [read, strip]) {
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    if (!box) throw new Error('the control is on the page');
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(small.width);
    expect(await pressable(control)).toBe(true);
  }
  // Nothing sticks out to the side: not the page, and not the cover's own column.
  const across = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - window.innerWidth,
    cover: (() => {
      const node = document.querySelector('[data-testid="essay-cover"]');
      const scroller = node?.querySelector('div');
      return Math.max(
        (node?.scrollWidth ?? 0) - (node?.clientWidth ?? 0),
        (scroller?.scrollWidth ?? 0) - (scroller?.clientWidth ?? 0),
      );
    })(),
  }));
  expect(across.page).toBeLessThanOrEqual(0);
  expect(across.cover).toBeLessThanOrEqual(0);
  // The Read button is a real way in even here.
  await read.click();
  await expect(readerTitle(page, 1)).toBeVisible();
});
