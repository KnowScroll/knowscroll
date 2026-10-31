import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { PARTY_CALL, openParty, partyWorld, type PartyWorld, type Who } from './thread-party-fixture';

const playableVideo = readFileSync(join(__dirname, 'fixtures', 'blue-60s.webm'));

/**
 * "Call it together" (v3 T-E, D-155 to D-157) in the production export: two people in one thread of a series, each in
 * their own browser context, over labelled HTTP fixtures that keep the real server's rules for the call (no backend):
 * a pick stays hidden until its member has locked and the party has finished the part, and the reveal waits for every
 * member who shares where they are. Meera is a third member with no browser. Screenshots are written only when
 * `KS_CALL_SHOTS` names a folder.
 */
const phone = { width: 390, height: 844 };
const desktop = { width: 1440, height: 900 };

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
  const folder = process.env['KS_CALL_SHOTS'];
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

/** Opens the call from the bar above the composer (a phone) and waits for the card. */
async function openCard(page: Page) {
  await page.getByTestId('call-bar').click();
  await expect(page.getByTestId('call-card')).toBeVisible();
  await expect(page.getByTestId('call-prompt')).toHaveText(PARTY_CALL.prompt);
}

/** Picks an option by its words and presses Lock it in. */
async function lockIn(page: Page, option: number) {
  await page.getByTestId(`call-option-${String(option)}`).click();
  await page.getByTestId('call-lock').click();
}

/** Plays Part 2 in the thread's own player to its last second, the way a person does on a phone: sheet, Part 2, dock, Watch. */
async function watchPartTwo(page: Page) {
  await page.getByTestId('thread-series-button').click();
  const sheet = page.getByRole('dialog', { name: 'A SERIES · 3 PARTS' });
  await expect(sheet).toBeVisible();
  await page.waitForTimeout(450);
  await sheet.getByRole('button', { name: /^Part 2, CI part 2/ }).click();
  const dock = page.getByRole('button', { name: /^Open Part 2 of 3, CI part 2/ });
  if (await dock.isVisible()) await dock.click();
  await page.getByRole('button', { name: 'Watch', exact: true }).click();
  await expect(page.locator('video')).toHaveCount(1);
  const playing = () => page.locator('video').evaluate((node) => !(node as HTMLVideoElement).paused);
  if (!(await playing())) await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(playing).toBe(true);
}

test('a call waits above the composer; locking hides everyone else’s pick, and a second member sees only counts', async ({
  browser,
}) => {
  const world = partyWorld({ call: true });
  world.setPlace('meera', 1, 'on');
  const asha = await person(browser, world, 'asha');
  const ravi = await person(browser, world, 'ravi');

  await expect(asha.page.getByTestId('call-bar')).toHaveText('★ Call it first · 0 of 3 in');
  await shot(asha.page, 'call-390-bar');
  await openCard(asha.page);
  await expect(asha.page.getByText('CALL IT TOGETHER · BEFORE PART 2')).toBeVisible();
  await expect(asha.page.getByTestId('call-summary')).toHaveText(
    'Nobody has called yet · answers stay hidden until you call',
  );
  await expect(asha.page.getByTestId('call-lock')).toBeDisabled();
  await shot(asha.page, 'call-390-open');
  expect(await seriousViolations(asha.page)).toEqual([]);

  // Asha picks B and locks it.
  await lockIn(asha.page, 1);
  await expect.poll(() => world.lockOf('asha')).toBe(1);
  await expect(asha.page.getByTestId('call-summary')).toContainText('1 of 3 have called');
  await expect(asha.page.getByTestId('call-summary')).toContainText(
    'everyone who shares where they are has finished Part 2',
  );
  await expect(asha.page.getByTestId('call-lock')).toHaveCount(0);
  await expect(asha.page.getByLabel('Option B. CI half moon. Your call.')).toBeVisible();
  // What was sent: a part, an option and the recording generation. Not whether it was right, not a time.
  const [sent] = world.callCalls('asha', 'calls/lock');
  expect(Object.keys(sent!.body).toSorted()).toEqual(['option', 'part', 'recordingGeneration', 'thread', 'version']);
  expect(sent!.body).toMatchObject({ part: 2, option: 1 });
  await shot(asha.page, 'call-390-locked');
  expect(await seriousViolations(asha.page)).toEqual([]);

  // Ravi sees a count and nothing of Asha's pick, and locks by keys: 1 chooses A, Enter locks.
  await ravi.page.reload();
  await expect(ravi.page.getByTestId('call-bar')).toHaveText('★ Call it first · 1 of 3 in');
  await openCard(ravi.page);
  const card = ravi.page.getByTestId('call-card');
  await expect(card).not.toContainText('Asha');
  await expect(card).not.toContainText('YOUR CALL');
  await expect(ravi.page.getByTestId('call-summary')).toContainText('1 of 3 have called');
  await ravi.page.getByTestId('call-option-0').focus();
  await ravi.page.keyboard.press('1');
  await expect(ravi.page.getByTestId('call-option-0')).toHaveAttribute('aria-checked', 'true');
  await ravi.page.keyboard.press('Enter');
  await expect.poll(() => world.lockOf('ravi')).toBe(0);

  // Asha reads again: two have called, no names, no answer, no explanation.
  await asha.page.reload();
  await asha.page.getByTestId('call-bar').click();
  await expect(asha.page.getByTestId('call-summary')).toContainText('2 of 3 have called');
  const body = await asha.page.locator('body').innerText();
  expect(body).not.toContain(PARTY_CALL.explain);
  expect(body).not.toContain(PARTY_CALL.twist);
  expect(await asha.page.getByTestId('call-card').innerText()).not.toMatch(/Ravi|Meera/);
  await closeAll(asha.context, ravi.context);
});

test('the reveal waits for everyone who shares where they are, then shows every pick together', async ({ browser }) => {
  const world = partyWorld({ call: true });
  world.setPlace('meera', 1, 'on');
  world.setPlace('ravi', 2, 'finished');
  world.lock('ravi', 0);
  world.lock('meera', 0);
  const asha = await person(browser, world, 'asha');

  await openCard(asha.page);
  await lockIn(asha.page, 1);
  await expect.poll(() => world.lockOf('asha')).toBe(1);

  // Ravi finished Part 2; Meera is still on Part 1 and shares it: the party waits for her.
  await asha.page.reload();
  await asha.page.getByTestId('call-bar').click();
  await expect(asha.page.getByTestId('call-summary')).toContainText('3 of 3 have called');
  await expect(asha.page.getByTestId('call-explain')).toHaveCount(0);

  // Asha plays Part 2 in the thread's own player to its last second: now she has finished it too, and Meera still waits.
  await watchPartTwo(asha.page);
  await expect.poll(() => world.placeOf('asha')?.state, { timeout: 20_000 }).toBe('finished');
  await asha.page.reload();
  await asha.page.getByTestId('call-bar').click();
  await expect(asha.page.getByTestId('call-explain')).toHaveCount(0);

  // Meera finishes: everyone who shares has, and the call shows to those who locked.
  world.setPlace('meera', 2, 'finished');
  await asha.page.reload();
  await asha.page.getByTestId('call-bar').click();
  const card = asha.page.getByTestId('call-card');
  await expect(card.getByText('PLOT TWIST! · REVEALED TOGETHER')).toBeVisible();
  await expect(asha.page.getByTestId('call-explain')).toHaveText(PARTY_CALL.explain);
  await expect(asha.page.getByTestId('call-twist')).toHaveText(PARTY_CALL.twist);
  await expect(
    asha.page.getByLabel('Option A. CI full and new moon. Right answer. Called by Meera fixture and Ravi fixture.'),
  ).toBeVisible();
  await expect(asha.page.getByLabel('Option B. CI half moon. Your call: a plot twist. Called by you.')).toBeVisible();
  // A wrong call is a twist, never a loss: no spark, no minus, no count of misses.
  await expect(asha.page.getByTestId('call-spark')).toHaveCount(0);
  expect(await card.innerText()).not.toMatch(/-1|lost|wrong|incorrect/i);
  expect(await card.innerText()).not.toMatch(/\d{1,2}:\d{2}/);
  await shot(asha.page, 'call-390-revealed');
  expect(await seriousViolations(asha.page)).toEqual([]);

  // The reveal was opened here, so the bar stops offering it after the card is closed.
  await asha.page.getByTestId('call-close').click();
  await expect(asha.page.getByTestId('call-bar')).toHaveCount(0);
  await closeAll(asha.context);
});

test('a member who never calls, and one who hides where they are, do not hold the others back', async ({ browser }) => {
  const world = partyWorld({ call: true });
  // Ravi shows no place and never calls; Meera finished Part 2 and called it right.
  world.setPlace('meera', 2, 'finished');
  world.lock('meera', 0);
  world.setPlace('asha', 1, 'on');
  const asha = await person(browser, world, 'asha');
  await openCard(asha.page);
  await lockIn(asha.page, 0);
  await expect.poll(() => world.lockOf('asha')).toBe(0);
  // Asha shares that she is on Part 1, so the party waits for her; hiding where she is stops that wait.
  await asha.page.reload();
  await asha.page.getByTestId('call-bar').click();
  await expect(asha.page.getByTestId('call-explain')).toHaveCount(0);
  await asha.page.getByTestId('thread-series-button').click();
  const sheet = asha.page.getByRole('dialog', { name: 'A SERIES · 3 PARTS' });
  await asha.page.waitForTimeout(450);
  await sheet.getByRole('tab', { name: /^Members/ }).click();
  await sheet.getByRole('switch', { name: 'Hide where I am' }).click();
  await expect.poll(() => world.isHidden('asha')).toBe(true);
  await asha.page.keyboard.press('Escape');
  await asha.page.reload();
  await asha.page.getByTestId('call-bar').click();
  await expect(asha.page.getByTestId('call-card').getByText('CALLED IT! · REVEALED TOGETHER')).toBeVisible();
  await expect(asha.page.getByTestId('call-spark')).toHaveText('★ +1 for 2 of you');
  await shot(asha.page, 'call-390-called-it');
  await closeAll(asha.context);
});

test('while recording is paused nothing is sent, and the card says why', async ({ browser }) => {
  const world = partyWorld({ call: true });
  world.pauseRecording('ravi', true);
  const ravi = await person(browser, world, 'ravi');
  await openCard(ravi.page);
  await lockIn(ravi.page, 2);
  await expect(ravi.page.getByTestId('call-notice')).toContainText('Recording is paused.');
  expect(world.callCalls('ravi', 'calls/lock')).toHaveLength(0);
  expect(world.lockOf('ravi')).toBeUndefined();
  await shot(ravi.page, 'call-390-paused');
  expect(await seriousViolations(ravi.page)).toEqual([]);
  await closeAll(ravi.context);
});

test('a part you started cannot be called, and nothing offers it', async ({ browser }) => {
  const world = partyWorld({ call: true });
  world.setPlace('ravi', 2, 'on');
  const ravi = await person(browser, world, 'ravi');
  // Ravi started Part 2: the call is closed to him, and offers nothing.
  await expect(ravi.page.getByTestId('call-bar')).toHaveCount(0);
  await ravi.page.getByTestId('thread-series-button').click();
  const sheet = ravi.page.getByRole('dialog', { name: 'A SERIES · 3 PARTS' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId(/^call-chip-/)).toHaveCount(0);
  await closeAll(ravi.context);
});

test('on a desktop the Series panel carries the chip, and the call opens beside the conversation', async ({
  browser,
}) => {
  const world = partyWorld({ call: true });
  world.setPlace('meera', 1, 'on');
  const asha = await person(browser, world, 'asha', desktop);
  const { page } = asha;

  const panel = page.getByRole('region', { name: 'Thread' });
  const chip = panel.getByTestId('call-chip-2');
  await expect(chip).toHaveText('★ Call it first · 0 of 3 in');
  await chip.click();
  await expect(page.getByTestId('call-card')).toBeVisible();
  await expect(page.getByTestId('call-prompt')).toHaveText(PARTY_CALL.prompt);
  await shot(page, 'call-1440-open');
  expect(await seriousViolations(page)).toEqual([]);
  await lockIn(page, 0);
  await expect.poll(() => world.lockOf('asha')).toBe(0);
  await expect(chip).toHaveText('★ Called · waiting for the party');
  await expect(page.getByTestId('call-summary')).toContainText('1 of 3 have called');
  await shot(page, 'call-1440-locked');
  expect(await seriousViolations(page)).toEqual([]);

  // Everyone who shares has finished: the card reveals, with the right call and the spark.
  world.setPlace('meera', 2, 'finished');
  world.setPlace('asha', 2, 'finished');
  await page.reload();
  await page.getByRole('region', { name: 'Thread' }).getByTestId('call-chip-2').click();
  await expect(page.getByTestId('call-card').getByText('CALLED IT! · REVEALED TOGETHER')).toBeVisible();
  await expect(page.getByTestId('call-spark')).toHaveText('★ +1 spark');
  await shot(page, 'call-1440-revealed');
  expect(await seriousViolations(page)).toEqual([]);
  await closeAll(asha.context);
});
