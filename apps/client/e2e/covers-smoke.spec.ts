import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import { signedInAccount } from './account-fixture';
import { encounterFixture, id, type EncounterFixtureOptions } from './encounter-fixture';

/**
 * Covers in Explore (#747, #752) in the production export over labelled HTTP fixtures (no backend): Explore deals a hand
 * of covers and opens one only when asked, with no switch to turn on. The hands, the covers and the documents are
 * authored in `encounter-fixture.ts`, so this proves what the page does with them, not what the server chooses to deal.
 */

/** Screenshots are written only when `KS_COVERS_SHOTS` names a folder (for the PR; never inside the repository). */
async function shot(page: Page, name: string) {
  const folder = process.env['KS_COVERS_SHOTS'];
  if (folder === undefined) return;
  mkdirSync(folder, { recursive: true });
  // The figure draws in and the essay settles before it is looked at.
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(folder, `${name}.png`), fullPage: true });
}

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

/** Explore up to the first cover and past the first-arrival note. */
async function openCovers(
  page: Page,
  options: {
    readonly preferences?: Record<string, unknown>;
    readonly viewport?: { width: number; height: number };
    readonly fixture?: EncounterFixtureOptions;
  } = {},
) {
  const served = await encounterFixture(page, 'scroll', {
    covers: { hand: HAND },
    scrollDocument: document2,
    viewport: options.viewport ?? phone,
    ...(options.preferences === undefined ? {} : { devicePreferences: options.preferences }),
    ...options.fixture,
  });
  await page.goto('/explore');
  await expect(cover(page)).toBeVisible();
  // A cover names its own moves (the arrows, Read, the strip), so no first-arrival note is laid over Read.
  await expect(page.getByRole('note', { name: 'How to move around' })).toHaveCount(0);
  return served;
}

test('Explore arrives on a cover and opens nothing; it asked for covers', async ({ page }) => {
  const { commands } = await openCovers(page);
  await expect(coverTitle(page, 1)).toBeVisible();
  await expect(position(page, 1)).toBeVisible();
  await expect(cover(page).getByText('CI cover kicker 1', { exact: true })).toBeVisible();
  // Nothing was chosen on this device, and nothing needed to be: covers are how Explore offers a Scroll.
  expect(await page.evaluate(() => window.localStorage.getItem('ks.device.preferences'))).toBeNull();
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
  await expect(page.getByTestId('essay-cover-previous')).toHaveAttribute('aria-disabled', 'true');
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

test('Next idea from an essay opened from a cover deals a new hand; its Scroll opens from its cover with no Next-topic note', async ({
  page,
}) => {
  const { commands } = await openCovers(page);
  await page.getByTestId('essay-cover-read').click();
  await expect(readerTitle(page, 1)).toBeVisible();
  await page.getByRole('button', { name: 'Next topic' }).click();
  await expect(cover(page)).toBeVisible();
  await expect(coverTitle(page, 4)).toBeVisible();
  expect(callsTo(commands, '/v1/experience/navigate')).toHaveLength(1);
  expect(activations(commands)).toHaveLength(1);
  await page.getByTestId('essay-cover-read').click();
  await expect(readerTitle(page, 4)).toBeVisible();
  expect(activations(commands)).toHaveLength(2);
  // The cover said what it is, so the Scroll arrives with no note about the new topic, and Back is the Undo.
  await expect(page.getByTestId('format-note')).toHaveCount(0);
  await page.goBack();
  await expect(coverTitle(page, 4)).toBeVisible();
});

test('the format switch on an essay opened from a cover changes format at once: no cover for a move the person names', async ({
  page,
}) => {
  // A series serves each Scroll with its Reel ready, so the switch moves instead of asking for one.
  const { commands } = await openCovers(page, { fixture: { series: true } });
  await page.getByTestId('essay-cover-read').click();
  await expect(readerTitle(page, 1)).toBeVisible();
  await page
    .getByRole('radiogroup', { name: 'Format of this explanation' })
    .first()
    .getByRole('radio', { name: 'Reel', exact: true })
    .click();
  await expect.poll(() => callsTo(commands, '/v1/experience/navigate').length).toBe(1);
  expect(callsTo(commands, '/v1/experience/navigate')[0]?.body.intent).toMatchObject({ mode: 'variant', to: 'reel' });
  await expect.poll(() => activations(commands).length).toBe(2);
  await expect(cover(page)).toHaveCount(0);
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

test('there is no switch for covers on the Accessibility screen', async ({ page }) => {
  await signedInAccount(page);
  await page.setViewportSize(phone);
  await page.goto('/account/accessibility');
  await expect(page.getByRole('switch', { name: 'Start Reels with sound' })).toBeVisible();
  await expect(page.getByRole('switch', { name: /covers/i })).toHaveCount(0);
  await expect(page.getByText('Show Scrolls as covers')).toHaveCount(0);
  await shot(page, 'accessibility-no-switch-phone-dark');
});

test('an offer without a cover opens on arrival', async ({ page }) => {
  // A server that predates covers sends none: the page has nothing to show, so the Scroll opens and one activates.
  const { commands } = await encounterFixture(page, 'scroll', {
    covers: { absent: true },
    scrollDocument: document2,
  });
  await page.goto('/explore');
  await expect(readerTitle(page, 1)).toBeVisible();
  await expect(cover(page)).toHaveCount(0);
  expect(activations(commands)).toHaveLength(1);
});

test('a hand of Reels plays as before', async ({ page }) => {
  const { commands } = await encounterFixture(page, 'reel', { covers: { hand: HAND } });
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

for (const [label, viewport, text] of [
  ['390x844', phone, 'device'],
  ['1440x900', desktop, 'device'],
  ['320x568-largest', small, 'largest'],
] as const) {
  for (const appearance of ['light', 'dark'] as const) {
    test(`Explore arrives on a cover and Read opens the essay, in ${appearance} at ${label}`, async ({ page }) => {
      await openCovers(page, { viewport, preferences: { appearance, textSize: text } });
      await expect(coverTitle(page, 1)).toBeVisible();
      await shot(page, `cover-${label}-${appearance}`);
      await page.getByTestId('essay-cover-read').click();
      await expect(readerTitle(page, 1)).toBeVisible();
      await expect(page.getByTestId('folio-page')).toBeVisible();
      await expect(cover(page)).toHaveCount(0);
      await shot(page, `essay-${label}-${appearance}`);
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
