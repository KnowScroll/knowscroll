import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { id } from './encounter-fixture';
import { roomFixture } from './rooms-fixture';
import { WatchWorld, watchRoutes, type Who } from './rooms-watch-fixture';

/**
 * Watch together (v3 R-10) in the production export over labelled HTTP fixtures, for up to three people who share one room. Ravi starts
 * a Reel, Asha (and Kenji) join from other browsers, and every screen plays from one clock. The fixture keeps the server's rules: the
 * server's clock decides where the session is, no request carries a position, "N watching" is a number only from three people who
 * joined, and a person's own watch opens an encounter for them alone. These fixtures run no socket, so every change a screen shows came
 * from a durable read: that is the recovery after a dropped connection. Axe covers names, roles and contrast at 390 and 1440. With
 * `KS_ROOM_SHOTS` set to a folder, each step also saves a screenshot there (never inside the repository).
 */
const shotsFolder = process.env['KS_ROOM_SHOTS'];
async function shoot(page: Page, name: string) {
  if (shotsFolder === undefined) return;
  mkdirSync(shotsFolder, { recursive: true });
  await page.screenshot({ path: join(shotsFolder, `${name}.png`) });
}

async function seriousViolations(page: Page, within?: string) {
  const builder = new AxeBuilder({ page });
  if (within !== undefined) builder.include(within);
  const results = await builder
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({
      rule: violation.id,
      targets: violation.nodes.slice(0, 4).map((node) => `${node.target.join(' ')}  ${node.html.slice(0, 100)}`),
    }));
}

const VIEWPORTS = [
  { name: 'phone', size: { width: 390, height: 844 } },
  { name: 'desktop', size: { width: 1440, height: 900 } },
] as const;
const scope = { accountId: id(1), privacyEpoch: 1 };

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

/** One person's tab in the room, over the shared world. */
async function openRoom(
  page: Page,
  world: WatchWorld,
  who: Who,
  size: { width: number; height: number },
  extra: { recordingPaused?: boolean } = {},
) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { address } = await roomFixture(page, size, {
    others: 2,
    lastMessageMinutesAgo: 5,
    noticeSeen: true,
    watch: () => world.strip(),
    launch: () => ({ state: 'ready' as const }),
    ...(extra.recordingPaused === true ? { recordingPaused: true } : {}),
  });
  const network = await watchRoutes(page, world, who, scope);
  await page.goto(address);
  return network;
}

/** Another person's browser: a context of its own, so its cookies, routes and clock are its own. */
async function otherBrowser(
  browser: { newContext: () => Promise<BrowserContext> },
  world: WatchWorld,
  who: Who,
  size: { width: number; height: number },
  extra: { recordingPaused?: boolean } = {},
) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const network = await openRoom(page, world, who, size, extra);
  return { context, page, network };
}

/**
 * What a hint would do in the product: the screen reads the stage again. These fixtures run no socket, so a test that wants a screen to
 * notice a change now (rather than at its next poll, twenty seconds on) asks for the read the way a person coming back to the tab does.
 */
const readAgain = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));

/** The player's own position in seconds, read from the page's video: only ever this device's own. */
const playerSeconds = (page: Page) => page.locator('video').evaluate((node) => (node as HTMLVideoElement).currentTime);
const sharedSeconds = (world: WatchWorld) => (world.clock() ?? 0) / 1000;
/** The word under the picture, as seconds of the shared clock: "0:41 / 1:10 · synced for everyone". */
const lineSeconds = async (page: Page) => {
  const text = (await page.getByTestId('watch-line').first().textContent()) ?? '';
  const match = /^(\d+):(\d\d) \//.exec(text);
  return match === null ? undefined : Number(match[1]) * 60 + Number(match[2]);
};

/** D-140: on a phone the conversation keeps at least 60 percent of the screen when nothing is on the stage. */
async function expectConversationKeepsMostOfThePhone(page: Page) {
  const messages = await page.getByTestId('room-messages').boundingBox();
  expect(messages).not.toBeNull();
  const share = messages!.height / VIEWPORTS[0].size.height;
  // eslint-disable-next-line no-console -- the measurement is the evidence the slice reports
  console.log(
    `room at 390x844 with the Watch chip: messages ${String(Math.round(messages!.height))} px (${(share * 100).toFixed(1)} %)`,
  );
  expect(share).toBeGreaterThanOrEqual(0.6);
}

/** What was sent to the Watch routes: the keys of every body, never a value that is a time or a position. */
function keysSent(world: WatchWorld) {
  return [...new Set(world.calls.flatMap((call) => Object.keys(call.body)))].sort();
}

for (const { name, size } of VIEWPORTS) {
  test(`${name}: Ravi starts a Reel, Asha joins from another browser, and both play from the server's clock`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(150_000);
    const world = new WatchWorld(60_000);
    await openRoom(page, world, 'ravi', size);

    // Before anything starts: a chip that offers a Reel, no mark on the band, no stage, and the conversation keeps its room.
    await expect(page.getByTestId('now-strip')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Watch together, Start a Reel' })).toBeVisible();
    await expect(page.getByTestId('band-live')).toHaveCount(0);
    await expect(page.getByTestId('watch-stage')).toHaveCount(0);
    expect(await seriousViolations(page)).toEqual([]);
    if (name === 'phone') await expectConversationKeepsMostOfThePhone(page);

    // "Nothing on stage right now" (R3 A2): it says so, says what was last on it and offers a Reel.
    await page.getByTestId('now-watch').click();
    await expect(page.getByTestId('watch-sheet')).toBeVisible();
    await expect(page.getByTestId('watch-nothing-live')).toContainText('Nothing on stage right now');
    await expect(page.getByTestId('watch-last')).toContainText(/^Last on stage: the Launch, /);
    await expect(page.getByTestId('watch-quiz')).toBeVisible();
    await expect(page.getByTestId('watch-sheet')).toHaveCSS('opacity', '1');
    await shoot(page, `${name}-1-nothing-live`);
    expect(await seriousViolations(page)).toEqual([]);

    // The Reels the room's topic rests on, one tap each. Nothing starts without the tap.
    await page.getByTestId('watch-choose').click();
    await expect(page.getByTestId('watch-reels')).toContainText('How big is the universe?');
    await expect(page.getByTestId('watch-reels')).toContainText('Reel · 1:00');
    expect(world.live()).toBe(false);
    await shoot(page, `${name}-2-choose-a-reel`);
    expect(await seriousViolations(page)).toEqual([]);
    await page.getByRole('button', { name: 'Watch How big is the universe? together' }).click();

    // The stage opens above General, with the first frame a few seconds on and a mark on the band.
    await expect(page.getByTestId('watch-stage')).toBeVisible();
    await expect(page.getByTestId('band-live')).toBeVisible();
    await expect(page.getByTestId('now-watch')).toHaveCount(0);
    await expect(page.getByTestId('room-messages')).toBeVisible();
    if (name === 'phone') {
      // While a Reel is on the stage takes the top of the phone (R3 A2); the share General keeps is recorded, not asserted (D-257).
      const messages = await page.getByTestId('room-messages').boundingBox();
      // eslint-disable-next-line no-console -- the measurement is the evidence the slice reports
      console.log(
        `room at 390x844 while a Reel is on: messages ${String(Math.round(messages?.height ?? 0))} px (${(((messages?.height ?? 0) / VIEWPORTS[0].size.height) * 100).toFixed(1)} %)`,
      );
    }
    await shoot(page, `${name}-3-starting`);
    expect(await seriousViolations(page)).toEqual([]);

    // Ravi's Reel plays from the shared clock.
    await expect(page.locator('video')).toHaveCount(1, { timeout: 20_000 });
    await expect(page.getByTestId('watch-line')).toContainText('synced for everyone');
    await expect
      .poll(async () => Math.abs((await playerSeconds(page)) - sharedSeconds(world)), { timeout: 20_000 })
      .toBeLessThan(3);

    // Asha, in another browser, sees it is on and has not joined: nothing opened for her, nothing sent about her, no number.
    const { context, page: asha } = await otherBrowser(browser, world, 'asha', size);
    await expect(asha.getByTestId('watch-stage')).toBeVisible({ timeout: 15_000 });
    await expect(asha.getByTestId('watch-invitation')).toContainText('REEL · SHARED BY RAVI');
    await expect(asha.getByTestId('watch-join')).toBeEnabled();
    await expect(asha.locator('video')).toHaveCount(0);
    await expect(asha.getByTestId('watch-count')).toHaveCount(0);
    expect(world.exposures.get('asha') ?? []).toEqual([]);
    expect(world.observed.filter((event) => event.who === 'asha')).toEqual([]);
    await shoot(asha, `${name}-4-invitation-asha`);
    expect(await seriousViolations(asha)).toEqual([]);

    // She joins: her own encounter opens now, and she plays from where the room is, not from the start.
    await asha.getByTestId('watch-join').click();
    await expect(asha.locator('video')).toHaveCount(1, { timeout: 20_000 });
    expect(world.viewers.has('asha')).toBe(true);
    expect(world.exposures.get('asha') ?? []).toHaveLength(1);
    await expect
      .poll(async () => Math.abs((await playerSeconds(asha)) - sharedSeconds(world)), { timeout: 20_000 })
      .toBeLessThan(3);
    await expect
      .poll(async () => Math.abs(((await lineSeconds(asha)) ?? 0) - sharedSeconds(world)), { timeout: 5_000 })
      .toBeLessThan(2.5);
    // Two people joined: no "N watching" anywhere, on either screen.
    await expect(page.getByTestId('watch-count')).toHaveCount(0);
    await expect(asha.getByTestId('watch-count')).toHaveCount(0);
    await expect(asha.getByText(/\d+ watching/)).toHaveCount(0);
    await shoot(asha, `${name}-5-playing-asha`);
    await shoot(page, `${name}-5b-playing-ravi`);
    expect(await seriousViolations(asha)).toEqual([]);
    expect(await seriousViolations(page)).toEqual([]);

    // Asha pauses for herself: nothing changes for Ravi; when she plays again she is back at the room's place.
    const ravisBefore = await playerSeconds(page);
    await asha.getByRole('button', { name: 'Pause' }).click();
    await expect.poll(() => asha.locator('video').evaluate((node) => (node as HTMLVideoElement).paused)).toBe(true);
    await asha.waitForTimeout(4_500);
    expect(await playerSeconds(page)).toBeGreaterThan(ravisBefore + 3);
    expect(await page.locator('video').evaluate((node) => (node as HTMLVideoElement).paused)).toBe(false);
    await asha.getByRole('button', { name: 'Play' }).click();
    await expect
      .poll(async () => Math.abs((await playerSeconds(asha)) - sharedSeconds(world)), { timeout: 15_000 })
      .toBeLessThan(3);

    // What is sent and what is stored: the Watch routes carry a Reel, a session and a generation, never a position or a time; each
    // person's observations name only their own encounter; nothing was opened for anyone who did not choose to watch.
    expect(keysSent(world)).toEqual(
      ['assetId', 'commandId', 'readId', 'recordingGeneration', 'roomId', 'sessionId', 'version'].sort(),
    );
    expect(JSON.stringify(world.calls)).not.toMatch(/position|elapsed|currentTime|startsAt|positionMs/i);
    for (const who of ['ravi', 'asha'] as const)
      for (const event of world.observed.filter((entry) => entry.who === who))
        expect(world.exposures.get(who)).toContain(event.exposureId);
    expect(world.exposures.get('ravi')).toHaveLength(1);
    expect(world.exposures.get('asha')).toHaveLength(1);
    expect(world.exposures.get('kenji') ?? []).toEqual([]);

    // Ravi leaves the stage: he is not counted, nothing of his is kept, and the session goes on for Asha.
    await page.getByTestId('watch-leave').click();
    await expect(page.getByTestId('watch-invitation')).toBeVisible();
    await expect(page.locator('video')).toHaveCount(0);
    expect(world.viewers.has('ravi')).toBe(false);
    expect(world.viewers.has('asha')).toBe(true);
    await expect(asha.locator('video')).toHaveCount(1);
    await shoot(page, `${name}-6-left-ravi`);
    expect(await seriousViolations(page)).toEqual([]);

    // He shared it, so he can end it for everyone; Asha's screen finds it over on its next read.
    await page.getByTestId('watch-stop').click();
    await expect(page.getByTestId('watch-stage')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Watch together, Start a Reel' })).toBeVisible();
    await expect(page.getByTestId('band-live')).toHaveCount(0);
    await readAgain(asha);
    await expect(asha.getByTestId('watch-stage')).toHaveCount(0, { timeout: 25_000 });
    await shoot(asha, `${name}-7-ended-asha`);
    expect(await seriousViolations(page)).toEqual([]);
    await context.close();
  });
}

for (const { name, size } of VIEWPORTS) {
  test(`${name}: "N watching" appears only at three people who joined, never for people who only have the room open`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(150_000);
    const world = new WatchWorld(60_000);
    await openRoom(page, world, 'ravi', size);
    const ashaTab = await otherBrowser(browser, world, 'asha', size);
    const kenjiTab = await otherBrowser(browser, world, 'kenji', size);
    // Three people have the room open. Ravi starts a Reel; only he has joined.
    await page.getByTestId('now-watch').click();
    await page.getByTestId('watch-choose').click();
    await page.getByRole('button', { name: 'Watch How big is the universe? together' }).click();
    await expect(page.getByTestId('watch-stage')).toBeVisible();
    for (const tab of [ashaTab, kenjiTab]) {
      await readAgain(tab.page);
      await expect(tab.page.getByTestId('watch-invitation')).toBeVisible({ timeout: 15_000 });
      await expect(tab.page.getByTestId('watch-count')).toHaveCount(0);
    }
    await expect(page.getByTestId('watch-count')).toHaveCount(0);

    // Asha joins: two joined, three present. Still no number, on any screen.
    await ashaTab.page.getByTestId('watch-join').click();
    await expect(ashaTab.page.locator('video')).toHaveCount(1, { timeout: 20_000 });
    await expect(ashaTab.page.getByTestId('watch-count')).toHaveCount(0);
    await expect(kenjiTab.page.getByText(/\d+ watching/)).toHaveCount(0);

    // Kenji joins: three joined. The number appears, the same on each screen once it has read the stage again.
    await kenjiTab.page.getByTestId('watch-join').click();
    await expect(kenjiTab.page.locator('video')).toHaveCount(1, { timeout: 20_000 });
    await expect(kenjiTab.page.getByTestId('watch-count')).toHaveText('3 watching');
    for (const tab of [page, ashaTab.page]) await readAgain(tab);
    await expect(page.getByTestId('watch-count')).toHaveText('3 watching', { timeout: 25_000 });
    await expect(ashaTab.page.getByTestId('watch-count')).toHaveText('3 watching', { timeout: 25_000 });
    await shoot(page, `${name}-8-three-watching`);
    expect(await seriousViolations(page)).toEqual([]);
    expect(await seriousViolations(kenjiTab.page)).toEqual([]);

    // The number says nothing of who: no screen names anyone who joined, and nothing carries a position.
    for (const tab of [page, ashaTab.page, kenjiTab.page])
      await expect(tab.getByText(/Kenji is watching|Asha is watching|joined the stage|watching with/i)).toHaveCount(0);
    expect(JSON.stringify(world.calls)).not.toMatch(/position|elapsed|currentTime/i);

    // Kenji leaves: back to two, and the number is gone again.
    await kenjiTab.page.getByTestId('watch-leave').click();
    for (const tab of [page, ashaTab.page]) await readAgain(tab);
    await expect(page.getByTestId('watch-count')).toHaveCount(0, { timeout: 25_000 });
    await expect(ashaTab.page.getByTestId('watch-count')).toHaveCount(0, { timeout: 25_000 });
    await ashaTab.context.close();
    await kenjiTab.context.close();
  });
}

test('phone: a dropped connection keeps time and the stage recovers from one durable read, with no hint', async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  const size = VIEWPORTS[0].size;
  const world = new WatchWorld(60_000);
  const ravi = await openRoom(page, world, 'ravi', size);
  const ashaTab = await otherBrowser(browser, world, 'asha', size);
  const kenjiTab = await otherBrowser(browser, world, 'kenji', size);
  await page.getByTestId('now-watch').click();
  await page.getByTestId('watch-choose').click();
  await page.getByRole('button', { name: 'Watch How big is the universe? together' }).click();
  await expect(page.locator('video')).toHaveCount(1, { timeout: 20_000 });
  await ashaTab.page.getByTestId('watch-join').click();
  await expect(ashaTab.page.locator('video')).toHaveCount(1, { timeout: 20_000 });

  // Ravi's connection drops. While it is down Kenji joins (three have now joined). Ravi's screen keeps counting the clock by itself.
  ravi.drop();
  await kenjiTab.page.getByTestId('watch-join').click();
  await expect(kenjiTab.page.locator('video')).toHaveCount(1, { timeout: 20_000 });
  const before = await lineSeconds(page);
  await readAgain(page);
  await expect(page.getByTestId('watch-offline')).toContainText('Reconnecting');
  await shoot(page, 'phone-9-dropped');
  expect(await seriousViolations(page)).toEqual([]);
  await page.waitForTimeout(3_200);
  expect((await lineSeconds(page)) ?? 0).toBeGreaterThanOrEqual((before ?? 0) + 3);
  await expect(page.getByTestId('watch-count')).toHaveCount(0);
  expect(Math.abs((await playerSeconds(page)) - sharedSeconds(world))).toBeLessThan(3.5);

  // The connection is back: the next read is the whole truth. The banner goes, the number appears, the player is still on the clock.
  ravi.restore();
  await readAgain(page);
  await expect(page.getByTestId('watch-offline')).toHaveCount(0, { timeout: 25_000 });
  await expect(page.getByTestId('watch-count')).toHaveText('3 watching', { timeout: 25_000 });
  expect(Math.abs((await playerSeconds(page)) - sharedSeconds(world))).toBeLessThan(3.5);
  await shoot(page, 'phone-10-recovered');
  await ashaTab.context.close();
  await kenjiTab.context.close();
});

test('phone: a Reel that runs out ends the stage on every screen by itself, and the stage is free again', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const size = VIEWPORTS[0].size;
  const world = new WatchWorld(12_000);
  await openRoom(page, world, 'ravi', size);
  const ashaTab = await otherBrowser(browser, world, 'asha', size);
  await page.getByTestId('now-watch').click();
  await page.getByTestId('watch-choose').click();
  await page.getByRole('button', { name: 'Watch How big is the universe? together' }).click();
  await readAgain(ashaTab.page);
  await expect(ashaTab.page.getByTestId('watch-invitation')).toBeVisible({ timeout: 15_000 });
  await ashaTab.page.getByTestId('watch-join').click();
  await expect(ashaTab.page.locator('video')).toHaveCount(1, { timeout: 20_000 });

  // The last frame is due: each screen finds it out by itself, from its own count of the server's clock, reads the stage and finds it
  // free. Nobody pressed anything and no hint arrived.
  await expect(page.getByTestId('watch-stage')).toHaveCount(0, { timeout: 40_000 });
  await expect(ashaTab.page.getByTestId('watch-stage')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Watch together, Start a Reel' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('band-live')).toHaveCount(0);
  await ashaTab.context.close();
});

test('phone: while recording is paused there is no Join, it says so before any tap, and nothing is sent or opened', async ({
  page,
  browser,
}) => {
  const size = VIEWPORTS[0].size;
  const world = new WatchWorld(60_000);
  await openRoom(page, world, 'ravi', size);
  await page.getByTestId('now-watch').click();
  await page.getByTestId('watch-choose').click();
  await page.getByRole('button', { name: 'Watch How big is the universe? together' }).click();
  await expect(page.getByTestId('watch-stage')).toBeVisible();
  const paused = await otherBrowser(browser, world, 'asha', size, { recordingPaused: true });
  await expect(paused.page.getByTestId('watch-invitation')).toBeVisible({ timeout: 15_000 });
  await expect(paused.page.getByTestId('watch-paused')).toContainText('Recording is paused.');
  await expect(paused.page.getByTestId('watch-join')).toBeDisabled();
  expect(await seriousViolations(paused.page)).toEqual([]);
  await shoot(paused.page, 'phone-11-recording-paused');
  expect(world.calls.filter((call) => call.who === 'asha' && /\/(join|start)$/.test(call.path))).toHaveLength(0);
  expect(world.exposures.get('asha') ?? []).toEqual([]);
  await paused.context.close();
});
