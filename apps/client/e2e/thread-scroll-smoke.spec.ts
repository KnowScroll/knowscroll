import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { PARTY_CALL, openParty, partyWorld, type PartyWorld, type Who } from './thread-party-fixture';

/**
 * The thread's own reader of a v2 Scroll (v3 T-D, T-E; D-153, D-155) in the production export: two people in one
 * thread of a series of three Scrolls, each in their own browser context, over labelled HTTP fixtures that keep the
 * real server's rules for places and the call (no backend). The Scrolls are the labelled v2 fixture `seasons-stage-ci`.
 * Screenshots are written only when `KS_THREAD_SCROLL_SHOTS` names a folder.
 */
const phone = { width: 390, height: 844 };
const desktop = { width: 1440, height: 900 };

async function person(browser: Browser, world: PartyWorld, who: Who, viewport = phone) {
  const context = await browser.newContext({ viewport, hasTouch: false });
  const page = await context.newPage();
  await openParty(page, world, who, viewport);
  await expect(page.getByRole('heading', { level: 1, name: 'CI series' })).toBeVisible();
  return { context, page };
}

async function shot(page: Page, name: string) {
  const folder = process.env['KS_THREAD_SCROLL_SHOTS'];
  if (folder === undefined) return;
  mkdirSync(folder, { recursive: true });
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(folder, `${name}.png`) });
}

async function seriousViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({
      rule: violation.id,
      targets: violation.nodes.slice(0, 3).map((node) => `${node.target.join(' ')} ${node.html.slice(0, 160)}`),
    }));
}

async function closeAll(...contexts: BrowserContext[]) {
  for (const context of contexts) await context.close();
}

/** Opens the call from the bar above the composer (a phone) and locks an option. */
async function lockCall(page: Page, option: number) {
  await page.getByTestId('call-bar').click();
  await expect(page.getByTestId('call-card')).toBeVisible();
  await page.getByTestId(`call-option-${String(option)}`).click();
  await page.getByTestId('call-lock').click();
}

/** Chooses a part in the Series sheet; a phone then has the part in the dock, a desktop in the player. */
async function choosePart(page: Page, part: number, viewport = phone) {
  if (viewport.width < 768) {
    await page.getByTestId('thread-series-button').click();
    const sheet = page.getByRole('dialog', { name: 'A SERIES · 3 PARTS' });
    await expect(sheet).toBeVisible();
    await page.waitForTimeout(450);
    await sheet.getByRole('button', { name: new RegExp(`^Part ${String(part)}, CI part ${String(part)}`) }).click();
  } else {
    await page
      .getByRole('region', { name: 'Thread' })
      .getByRole('button', { name: new RegExp(`^Part ${String(part)}, CI part ${String(part)}`) })
      .click();
  }
}

/** Presses Read on the chosen Scroll (the dock's button on a phone, the player's on a desktop). */
async function read(page: Page, viewport = phone) {
  await (
    viewport.width < 768
      ? page.getByRole('button', { name: 'Read', exact: true })
      : page.getByRole('button', { name: 'Read this Scroll' })
  ).click();
  await expect(page.getByTestId('stop-scroller')).toBeVisible();
  await expect(page.getByText('This needs an app update')).toHaveCount(0);
}

/** Goes to the end of the Scroll and presses the finish the thread's reader offers there. */
async function finishPart(page: Page, part: number) {
  await page.getByRole('button', { name: 'The end of this Scroll', exact: true }).click();
  await expect(page.getByTestId('end-tray')).toBeVisible();
  await page.getByRole('button', { name: 'I’ve finished this part' }).click();
  await expect(page.getByTestId('finished-part')).toContainText(
    `The thread can see you finished Part ${String(part)}.`,
  );
}

test('Read opens a v2 Scroll in the thread; finishing it tells the thread, and a locked call reveals once both have finished', async ({
  browser,
}) => {
  const world = partyWorld({ call: true, scrolls: true });
  const asha = await person(browser, world, 'asha');
  const ravi = await person(browser, world, 'ravi');

  // Both call before Part 2, then read it.
  await lockCall(asha.page, 1);
  await expect.poll(() => world.lockOf('asha')).toBe(1);
  await lockCall(ravi.page, 0);
  await expect.poll(() => world.lockOf('ravi')).toBe(0);

  await choosePart(ravi.page, 2);
  await read(ravi.page);
  // The Scroll opened: that is the start of the part, and not the tap on Read.
  await expect.poll(() => world.placeOf('ravi')).toMatchObject({ part: 2, state: 'on' });
  await shot(ravi.page, 'thread-scroll-390-reader');
  expect(await seriousViolations(ravi.page)).toEqual([]);
  await finishPart(ravi.page, 2);
  await expect.poll(() => world.placeOf('ravi')).toMatchObject({ part: 2, state: 'finished' });
  await shot(ravi.page, 'thread-scroll-390-finished');
  expect(await seriousViolations(ravi.page)).toEqual([]);

  // Asha has not finished Part 2: nothing is revealed yet, even though Ravi has.
  await choosePart(asha.page, 2);
  await read(asha.page);
  await expect.poll(() => world.placeOf('asha')).toMatchObject({ part: 2, state: 'on' });
  await asha.page.getByRole('button', { name: 'Back to thread' }).click();
  await expect(asha.page.getByTestId('thread-header')).toBeVisible();
  await asha.page.reload();
  await expect(asha.page.getByTestId('thread-header')).toBeVisible();
  await expect(asha.page.getByTestId('call-bar')).not.toHaveText(/Revealed/);

  // She reads it through and says so: now everyone who shares has finished, and the call shows to those who locked.
  await choosePart(asha.page, 2);
  await read(asha.page);
  await finishPart(asha.page, 2);
  await expect.poll(() => world.placeOf('asha')).toMatchObject({ part: 2, state: 'finished' });
  await asha.page.getByRole('button', { name: 'Back to thread' }).click();
  // Back is a navigation: reload only once the thread is the screen shown, or the reload aborts it.
  await expect(asha.page.getByTestId('thread-header')).toBeVisible();
  await asha.page.reload();
  await expect(asha.page.getByTestId('call-bar')).toHaveText('★ Revealed');
  await asha.page.getByTestId('call-bar').click();
  await expect(asha.page.getByTestId('call-card').getByText('PLOT TWIST! · REVEALED TOGETHER')).toBeVisible();
  await expect(asha.page.getByTestId('call-explain')).toHaveText(PARTY_CALL.explain);
  await shot(asha.page, 'thread-scroll-390-revealed');

  // What the reader sent: a part and a state, twice for Ravi's two reports and nothing else.
  for (const call of world.placeCalls('ravi', 'places/set'))
    expect(Object.keys(call.body).toSorted()).toEqual(['part', 'state', 'thread', 'version']);
  await closeAll(asha.context, ravi.context);
});

test('on a desktop the player reads the Scroll in place of the thread, and the finish tells the thread', async ({
  browser,
}) => {
  const world = partyWorld({ scrolls: true });
  const asha = await person(browser, world, 'asha', desktop);
  const { page } = asha;

  await choosePart(page, 1, desktop);
  await read(page, desktop);
  await expect.poll(() => world.placeOf('asha')).toMatchObject({ part: 1, state: 'on' });
  await shot(page, 'thread-scroll-1440-reader');
  expect(await seriousViolations(page)).toEqual([]);
  await page.getByRole('button', { name: 'The end of this Scroll', exact: true }).click();
  await page.getByRole('button', { name: 'I’ve finished this part' }).click();
  await expect.poll(() => world.placeOf('asha')).toMatchObject({ part: 1, state: 'finished' });
  await shot(page, 'thread-scroll-1440-finished');
  await closeAll(asha.context);
});

test('a Read that does not open the Scroll tells the thread nothing', async ({ browser }) => {
  const world = partyWorld({ scrolls: true });
  const ravi = await person(browser, world, 'ravi');
  // The Scroll will not open: the request for its document fails.
  await ravi.page.route('**/v1/experience/exposures/*/document', (route) => route.fulfill({ status: 500, json: {} }));

  await choosePart(ravi.page, 2);
  await ravi.page.getByRole('button', { name: 'Read', exact: true }).click();
  await expect(ravi.page.getByRole('heading', { name: "You're offline" })).toBeVisible();
  await expect(ravi.page.getByTestId('stop-scroller')).toHaveCount(0);
  // Give a wrongly sent report time to arrive.
  await ravi.page.waitForTimeout(1000);
  expect(world.placeCalls('ravi', 'places/set')).toHaveLength(0);
  expect(world.placeOf('ravi')).toBeUndefined();
  await closeAll(ravi.context);
});

test('while recording is paused opening a part tells nothing, and the button still shares the finish', async ({
  browser,
}) => {
  const world = partyWorld({ scrolls: true });
  world.pauseRecording('ravi', true);
  const ravi = await person(browser, world, 'ravi');

  await choosePart(ravi.page, 1);
  await read(ravi.page);
  await ravi.page.waitForTimeout(1000);
  expect(world.placeCalls('ravi', 'places/set')).toHaveLength(0);
  await ravi.page.getByRole('button', { name: 'The end of this Scroll', exact: true }).click();
  await ravi.page.getByRole('button', { name: 'I’ve finished this part' }).click();
  await expect.poll(() => world.placeOf('ravi')).toMatchObject({ part: 1, state: 'finished' });
  await closeAll(ravi.context);
});
