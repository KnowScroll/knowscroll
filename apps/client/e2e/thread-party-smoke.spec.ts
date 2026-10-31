import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { id } from './encounter-fixture';
import { openParty, partyWorld, type PartyWorld, type Who } from './thread-party-fixture';

const playableVideo = readFileSync(join(__dirname, 'fixtures', 'blue-60s.webm'));

/**
 * A thread as a party (v3 T-D, D-065) in the production export: two people in one thread of a series, each in
 * their own browser context, over labelled HTTP fixtures that keep the real server's rules for places (no
 * backend). What one person's player reports the other reads. Screenshots are written only when `KS_PARTY_SHOTS`
 * names a folder.
 */
const phone = { width: 390, height: 844 };
const desktop = { width: 1440, height: 900 };
/** Anything that says someone is watching, or a clock time, in a party line. */
const watching = /watching|is watching|now playing/i;

async function person(browser: Browser, world: PartyWorld, who: Who, viewport = phone) {
  const context = await browser.newContext({ viewport, hasTouch: false });
  const page = await context.newPage();
  await page.route('**/media/talk-fixture', (route) =>
    route.fulfill({ status: 200, contentType: 'video/webm', body: playableVideo }),
  );
  await openParty(page, world, who, viewport);
  await expect(page.getByRole('heading', { level: 1, name: 'CI series' })).toBeVisible();
  return { context, page };
}

async function shot(page: Page, name: string) {
  const folder = process.env['KS_PARTY_SHOTS'];
  if (folder === undefined) return;
  mkdirSync(folder, { recursive: true });
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(folder, `${name}.png`) });
}

async function seriousViolations(page: Page, within?: string) {
  const builder = new AxeBuilder({ page });
  const results = await (within === undefined ? builder : builder.include(within))
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({
      rule: violation.id,
      targets: violation.nodes
        .slice(0, 3)
        .map(
          (node) => `${node.target.join(' ')} ${node.html.slice(0, 160)} ${node.failureSummary?.slice(0, 200) ?? ''}`,
        ),
    }));
}

async function closeAll(...contexts: BrowserContext[]) {
  for (const context of contexts) await context.close();
}

/** Opens Part 1 in the thread's own player and plays it, the way a person does on a phone: dock, Watch, Play. */
async function watchFirstPart(page: Page) {
  const dock = page.getByRole('button', { name: /^Open Part 1 of 3, CI part 1/ });
  if (await dock.isVisible()) await dock.click();
  await page.getByRole('button', { name: 'Watch', exact: true }).click();
  await expect(page.locator('video')).toHaveCount(1);
  const playing = () => page.locator('video').evaluate((node) => !(node as HTMLVideoElement).paused);
  if (!(await playing())) await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(playing).toBe(true);
}

async function openSeries(page: Page, tab: 'Parts' | 'Members') {
  await page.getByTestId('thread-series-button').click();
  const sheet = page.getByRole('dialog', { name: 'A SERIES · 3 PARTS' });
  await expect(sheet).toBeVisible();
  // The sheet drops in over 240 ms: contrast is judged once it has settled.
  await page.waitForTimeout(450);
  if (tab === 'Members') await sheet.getByRole('tab', { name: /^Members/ }).click();
  return sheet;
}

test('the header shows each member’s face on their part, and the line says where the others are', async ({
  browser,
}) => {
  const world = partyWorld();
  world.setPlace('meera', 1, 'on');
  const asha = await person(browser, world, 'asha');
  const { page } = asha;

  await expect(page.getByTestId('part-worlds')).toBeVisible();
  const meera = id(12);
  await expect(page.getByTestId('part-world-1').getByTestId(`face-${meera}`)).toBeAttached();
  await expect(page.getByTestId('party-line')).toHaveText('Meera fixture is on Part 1');
  // Ravi has not opened a part: his world has no face, and nothing says why.
  await expect(page.getByTestId('part-world-2').getByTestId(/^face-/)).toHaveCount(0);
  expect(await page.locator('body').innerText()).not.toMatch(watching);

  // The conversation keeps the screen: the line is one slim row under the 72 px header.
  const header = await page.getByTestId('thread-header').boundingBox();
  const messages = await page.getByTestId('thread-messages').boundingBox();
  expect(header!.height).toBeLessThanOrEqual(73);
  const line = await page.getByTestId('party-line').boundingBox();
  // eslint-disable-next-line no-console -- the measurement is the evidence the slice reports
  console.log(
    `party thread at 390x844: header ${String(header!.height)} px, line ${String(line!.height)} px, messages ${String(messages!.height)} px (${((messages!.height / phone.height) * 100).toFixed(1)} %)`,
  );
  expect(messages!.height / phone.height).toBeGreaterThanOrEqual(0.6);
  await shot(page, 'thread-390-party');
  await closeAll(asha.context);
});

test('opening a part in the player and finishing it tell the thread; the other person reads it', async ({
  browser,
}) => {
  const world = partyWorld();
  world.setPlace('meera', 1, 'on');
  const asha = await person(browser, world, 'asha');
  const ravi = await person(browser, world, 'ravi');

  await watchFirstPart(ravi.page);
  await expect.poll(() => world.placeOf('ravi')?.state).toBe('on');
  expect(world.placeOf('ravi')).toMatchObject({ part: 1, state: 'on', day: '2026-10-24' });
  await asha.page.reload();
  await expect(asha.page.getByTestId('party-line')).toHaveText('Meera fixture and Ravi fixture are on Part 1');
  await expect(asha.page.getByTestId('part-world-1').getByTestId(/^face-/)).toHaveCount(2);
  await shot(asha.page, 'thread-390-ravi-on-part-1');

  // The Reel is a few seconds long: played to its last second, the part is finished.
  await expect.poll(() => world.placeOf('ravi')?.state, { timeout: 20_000 }).toBe('finished');
  await asha.page.reload();
  await expect(asha.page.getByTestId('party-line')).toHaveText(
    'Ravi fixture finished Part 1 · Meera fixture on Part 1',
  );

  // What was sent: only a part and a state. No time, no playhead, no branch, nothing about what was watched.
  const sent = world.placeCalls('ravi', 'places/set');
  expect(sent.length).toBeGreaterThanOrEqual(2);
  for (const call of sent)
    expect(Object.keys(call.body).toSorted()).toEqual(['commandId', 'part', 'state', 'thread', 'version']);
  expect(sent.map((call) => `${String(call.body['part'])}:${String(call.body['state'])}`)).toEqual([
    '1:on',
    '1:finished',
  ]);
  await closeAll(asha.context, ravi.context);
});

test('the Series sheet has faces on its parts and a Members tab with where each member is and "Hide where I am"', async ({
  browser,
}) => {
  const world = partyWorld();
  world.setPlace('meera', 2, 'finished');
  world.setPlace('ravi', 1, 'on');
  const asha = await person(browser, world, 'asha');
  const { page } = asha;

  const sheet = await openSeries(page, 'Parts');
  await expect(sheet.getByRole('button', { name: /^Part 1, CI part 1.*Ravi fixture is on it\./ })).toBeVisible();
  await expect(sheet.getByRole('button', { name: /^Part 2, CI part 2.*Meera fixture finished it\./ })).toBeVisible();
  await shot(page, 'thread-390-series-parts');

  await sheet.getByRole('tab', { name: /^Members 3/ }).click();
  const members = sheet.getByTestId('thread-members');
  await expect(members.getByText('On Part 1 · Sat 24 Oct')).toBeVisible();
  await expect(members.getByText('Finished Part 2 · Sat 24 Oct')).toBeVisible();
  // Asha shows no place yet: her row shows her handle, as does anyone's who shares none.
  await expect(members.getByText('@ci.asha')).toBeVisible();
  const hide = members.getByRole('switch', { name: 'Hide where I am' });
  await expect(hide).toHaveAttribute('aria-checked', 'false');
  expect(await members.innerText()).not.toMatch(/watching|\d{1,2}:\d{2}/i);
  await shot(page, 'thread-390-series-members');
  expect(await seriousViolations(page, '[role="dialog"]')).toEqual([]);

  // Back closes the sheet and the thread stays; reopening starts on Parts again.
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  const again = await openSeries(page, 'Parts');
  await expect(again.getByRole('tab', { name: 'Parts' })).toHaveAttribute('aria-selected', 'true');
  await closeAll(asha.context);
});

test('hide where I am removes the place for everyone, writes nothing while it is on, and shows it again from memory', async ({
  browser,
}) => {
  const world = partyWorld();
  world.setPlace('meera', 1, 'on');
  const asha = await person(browser, world, 'asha');
  const ravi = await person(browser, world, 'ravi');

  await watchFirstPart(ravi.page);
  await expect.poll(() => world.placeOf('ravi')?.part).toBe(1);
  await asha.page.reload();
  await expect(asha.page.getByTestId('party-line')).toContainText('Ravi fixture');

  // Ravi hides: the row is gone, and Asha sees only Meera.
  const sheet = await openSeries(ravi.page, 'Members');
  await sheet.getByRole('switch', { name: 'Hide where I am' }).click();
  await expect.poll(() => world.isHidden('ravi')).toBe(true);
  expect(world.placeOf('ravi')).toBeUndefined();
  await expect(sheet.getByText('Hidden. Nobody in this thread sees which part you are on.')).toBeVisible();
  await asha.page.reload();
  await expect(asha.page.getByTestId('party-line')).toHaveText('Meera fixture is on Part 1');
  await expect(asha.page.getByTestId('part-world-1').getByTestId(/^face-/)).toHaveCount(1);
  await shot(ravi.page, 'thread-390-members-hidden');

  // While hidden, opening another part sends nothing.
  await ravi.page.keyboard.press('Escape');
  const before = world.placeCalls('ravi', 'places/set').length;
  const open = await openSeries(ravi.page, 'Parts');
  await open.getByRole('button', { name: /^Part 2, CI part 2/ }).click();
  await ravi.page.getByRole('button', { name: 'Watch', exact: true }).click();
  await expect(ravi.page.locator('video')).toHaveCount(1);
  await ravi.page.waitForTimeout(1500);
  expect(world.placeCalls('ravi', 'places/set').length).toBe(before);
  expect(world.placeOf('ravi')).toBeUndefined();

  // Showing it again sends where he is now: the furthest part he opened while hidden.
  const members = await openSeries(ravi.page, 'Members');
  await members.getByRole('switch', { name: 'Hide where I am' }).click();
  await expect.poll(() => world.isHidden('ravi')).toBe(false);
  await expect.poll(() => world.placeOf('ravi')?.part).toBe(2);
  await asha.page.reload();
  await expect(asha.page.getByTestId('party-line')).toHaveText('Ravi fixture is on Part 2 · Meera fixture on Part 1');
  await closeAll(asha.context, ravi.context);
});

test('choosing a part, or opening the Series sheet, tells nobody where you are', async ({ browser }) => {
  const world = partyWorld();
  const ravi = await person(browser, world, 'ravi');
  const sheet = await openSeries(ravi.page, 'Parts');
  await sheet.getByRole('button', { name: /^Part 2, CI part 2/ }).click();
  await expect(ravi.page.getByRole('button', { name: /^Open Part 2 of 3, CI part 2/ })).toBeVisible();
  await ravi.page.getByRole('button', { name: /^Open Part 2 of 3, CI part 2/ }).click();
  await ravi.page.waitForTimeout(800);
  expect(world.placeCalls('ravi', 'places/set')).toHaveLength(0);
  expect(world.placeOf('ravi')).toBeUndefined();
  await closeAll(ravi.context);
});

test('on a desktop the panel lists the members and where they are beside the parts with faces', async ({ browser }) => {
  const world = partyWorld();
  world.setPlace('meera', 2, 'on');
  world.setPlace('ravi', 1, 'finished');
  const asha = await person(browser, world, 'asha', desktop);
  const { page } = asha;

  const panel = page.getByRole('region', { name: 'Thread' });
  await expect(panel.getByText('MEMBERS · WHERE THEY ARE')).toBeVisible();
  await expect(panel.getByText('Finished Part 1 · Sat 24 Oct')).toBeVisible();
  await expect(panel.getByText('On Part 2 · Sat 24 Oct')).toBeVisible();
  await expect(panel.getByRole('switch', { name: 'Hide where I am' })).toBeVisible();
  await expect(panel.getByRole('button', { name: /^Part 1, CI part 1.*Ravi fixture finished it\./ })).toBeVisible();
  await expect(page.getByTestId('party-line')).toHaveText('Meera fixture is on Part 2 · Ravi fixture finished Part 1');
  await expect(page.getByTestId('thread-series-button')).toHaveCount(0);
  expect(await page.locator('body').innerText()).not.toMatch(watching);
  await shot(page, 'thread-1440-party');
  expect(await seriousViolations(page)).toEqual([]);
  await closeAll(asha.context);
});

test('a phone thread with places has no serious accessibility violation, header and sheet', async ({ browser }) => {
  const world = partyWorld();
  world.setPlace('meera', 3, 'finished');
  world.setPlace('ravi', 2, 'on');
  const asha = await person(browser, world, 'asha');
  expect(await seriousViolations(asha.page)).toEqual([]);
  // With the sheet open the page behind it is dimmed by the scrim and inert, so only the sheet is checked.
  await openSeries(asha.page, 'Parts');
  expect(await seriousViolations(asha.page, '[role="dialog"]')).toEqual([]);
  await closeAll(asha.context);
});

test('when everyone who shares has finished the last part the line says "All finished"', async ({ browser }) => {
  const world = partyWorld();
  world.setPlace('meera', 3, 'finished');
  world.setPlace('ravi', 3, 'finished');
  const asha = await person(browser, world, 'asha');
  await expect(asha.page.getByTestId('party-line')).toHaveText('All finished');
  await shot(asha.page, 'thread-390-all-finished');
  await closeAll(asha.context);
});
