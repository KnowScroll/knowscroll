import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { openParty, type Who } from './thread-party-fixture';
import { FIXTURE_ANSWER, whatIfWorld, type WhatIfWorld } from './thread-whatif-fixture';

/**
 * What if in a thread, with its short answer card (v3 T-F, D-211): two people in one thread, each in their own browser
 * context, over labelled HTTP fixtures that keep the real server's rules for branches (no backend). Asha asks, the card
 * waits honestly for about 30 seconds, then shows the checked answer to both of them; the sixth branch of a day is
 * refused; cancelling removes the card for everyone. Screenshots are written only when `KS_WHATIF_SHOTS` names a folder.
 */
const phone = { width: 390, height: 844 };
const desktop = { width: 1440, height: 900 };
const MAKING = 'Making a short what-if · about 30 s · keep chatting';
/** Anything that says where another member is or what they have open. */
const position = /watching|is on part|currently|opened by (?!you)/i;

async function person(browser: Browser, world: WhatIfWorld, who: Who, viewport = phone) {
  const context = await browser.newContext({ viewport, hasTouch: false });
  const page = await context.newPage();
  await openParty(page, world, who, viewport);
  await expect(page.getByRole('heading', { level: 1, name: 'CI series' })).toBeVisible();
  return { context, page };
}

async function shot(page: Page, name: string) {
  const folder = process.env['KS_WHATIF_SHOTS'];
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

/** Asks What if from the whole thread and chooses the one idea the Planner proposes, the way a person does. */
async function askWhatIf(page: Page) {
  await page.getByTestId('ask-what-if').click();
  const sheet = page.getByTestId('scenario-sheet');
  await sheet.getByLabel('Your idea').fill('what if the moon was twice its size');
  await sheet.getByRole('button', { name: 'Continue', exact: true }).click();
  await sheet.getByRole('button', { name: 'Explore', exact: true }).click();
  await expect(sheet.getByText('Branch started.')).toBeVisible();
  await sheet.getByRole('button', { name: 'Back to the thread' }).click();
  await expect(sheet).toHaveCount(0);
}

test('the asker waits honestly, the other member sees the same wait, and the answer arrives for both', async ({
  browser,
}) => {
  const world = whatIfWorld();
  const asha = await person(browser, world, 'asha');
  const ravi = await person(browser, world, 'ravi');

  await askWhatIf(asha.page);
  const first = world.nodes[0]!;
  const mine = asha.page.getByTestId('what-if-card');
  await expect(mine).toBeVisible();
  await expect(mine.getByTestId('what-if-label')).toHaveText('What-if · made by KnowScroll');
  await expect(mine.getByText(MAKING)).toBeVisible();
  await expect(mine.getByText('We check it before it posts.')).toBeVisible();
  // Nothing is claimed that has not happened: no checked answer, nothing to open, and Cancel is the asker's own.
  await expect(mine.getByText('ASSUMED')).toHaveCount(0);
  await expect(mine.getByRole('button', { name: 'Open', exact: true })).toHaveCount(0);
  await expect(mine.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  await shot(asha.page, 'whatif-390-making');

  // Ravi, a member, reads the same card in the same wait: it names Asha, and he cannot cancel it.
  await ravi.page.reload();
  const theirs = ravi.page.getByTestId('what-if-card');
  await expect(theirs.getByText(MAKING)).toBeVisible();
  await expect(theirs.getByText('WHAT-IF · MAKING IT')).toBeVisible();
  await expect(theirs.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);

  // The writer finishes. Neither page is reloaded: the board is read again while a short answer is being made.
  world.finishAnswer(first.nodeId);
  for (const { page } of [asha, ravi]) {
    const card = page.getByTestId('what-if-card');
    await expect(card.getByTestId('what-if-assumed')).toContainText(FIXTURE_ANSWER.assumption, { timeout: 15_000 });
    await expect(card.getByTestId('what-if-changed')).toContainText('The Moon is twice as wide as it is');
    await expect(card.getByTestId('what-if-kept')).toContainText(
      'Its distance, Earth’s spin and the Sun’s pull stay the same',
    );
    await expect(card.getByTestId('what-if-answer')).toContainText('Tides would likely be much stronger');
    await expect(card.getByText('about 2 m')).toBeVisible();
    await expect(card.getByTestId('what-if-label')).toHaveText('What-if · made by KnowScroll');
    await expect(page.getByTestId('what-if-ready-line')).toContainText('WHAT-IF READY');
    // The full Scroll is still being made, so there is nothing to open yet, and the card says so.
    await expect(card.getByRole('button', { name: 'Open', exact: true })).toHaveCount(0);
    await expect(card.getByTestId('what-if-scroll-note')).toContainText('still being made');
  }
  await expect(asha.page.getByTestId('what-if-card').getByText('ASKED BY YOU', { exact: false })).toBeVisible();
  await expect(
    ravi.page.getByTestId('what-if-card').getByText('ASKED BY ASHA FIXTURE', { exact: false }),
  ).toBeVisible();
  await shot(asha.page, 'whatif-390-ready');
  await shot(ravi.page, 'whatif-390-ready-ravi');

  // The full Scroll is admitted: Open and Branch again appear, for everyone in the thread.
  world.bindScroll(first.nodeId);
  for (const { page } of [asha, ravi]) {
    const card = page.getByTestId('what-if-card');
    await expect(card.getByRole('button', { name: 'Open', exact: true })).toBeVisible({ timeout: 25_000 });
    await expect(card.getByRole('button', { name: 'Branch again' })).toBeVisible();
    await expect(card.getByTestId('what-if-scroll-note')).toHaveCount(0);
  }
  await expect(asha.page.getByTestId('what-if-card').getByRole('button', { name: 'Cancel' })).toHaveCount(0);

  // Nothing says where anyone is or what they opened, and what Ravi sent was only reads.
  for (const { page } of [asha, ravi]) expect(await page.locator('body').innerText()).not.toMatch(position);
  expect(world.requests.filter((call) => call.who === 'ravi' && /choose|draft$|remove/.test(call.path))).toEqual([]);

  expect(await seriousViolations(asha.page)).toEqual([]);
  expect(await seriousViolations(ravi.page)).toEqual([]);
  await closeAll(asha.context, ravi.context);
});

test('the sixth branch of a thread’s day is refused honestly, and nothing is written', async ({ browser }) => {
  const world = whatIfWorld();
  world.seedToday(4);
  const asha = await person(browser, world, 'asha');
  const { page } = asha;
  await expect(page.getByTestId('what-if-card')).toHaveCount(4);

  // The fifth is the last of the day.
  await askWhatIf(page);
  await expect(page.getByTestId('what-if-card')).toHaveCount(5);
  expect(world.nodes).toHaveLength(5);

  // The sixth is asked for like any other, and the server says no: the sheet says why and when it comes back.
  await page.getByTestId('ask-what-if').click();
  const sheet = page.getByTestId('scenario-sheet');
  await sheet.getByLabel('Your idea').fill('what if the moon was three times its size');
  await sheet.getByRole('button', { name: 'Continue', exact: true }).click();
  await sheet.getByRole('button', { name: 'Explore', exact: true }).click();
  await expect(sheet.getByText('This thread has made its five branches for today.')).toBeVisible();
  await expect(sheet.getByText(/midnight UTC/)).toBeVisible();
  await shot(page, 'whatif-390-sixth-refused');
  expect(await seriousViolations(page, '[role="dialog"]')).toEqual([]);
  await sheet.getByText('Close', { exact: true }).click();
  await expect(sheet).toHaveCount(0);
  expect(world.nodes).toHaveLength(5);
  await expect(page.getByTestId('what-if-card')).toHaveCount(5);
  await closeAll(asha.context);
});

test('cancelling the wait removes the card for everyone, with nothing left of what it would have said', async ({
  browser,
}) => {
  const world = whatIfWorld();
  const asha = await person(browser, world, 'asha');
  const ravi = await person(browser, world, 'ravi');
  await askWhatIf(asha.page);
  await ravi.page.reload();
  await expect(ravi.page.getByTestId('what-if-card')).toBeVisible();

  await asha.page.getByRole('button', { name: 'Cancel', exact: true }).click();
  for (const { page } of [asha, ravi]) {
    await expect(page.getByText('A branch was removed · nothing else changed')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('what-if-card')).toHaveCount(0);
  }
  expect(world.nodes[0]!.answer).toBeUndefined();
  await closeAll(asha.context, ravi.context);
});

test('a what-if that gets no short answer is the branch card it always was, with a plain line saying so', async ({
  browser,
}) => {
  const world = whatIfWorld();
  const asha = await person(browser, world, 'asha');
  await askWhatIf(asha.page);
  world.endAnswer(world.nodes[0]!.nodeId);
  await expect(asha.page.getByTestId('no-short-answer')).toHaveText('No short answer this time.', { timeout: 15_000 });
  await expect(asha.page.getByText('Preparing the first Scroll')).toBeVisible();
  await expect(asha.page.getByTestId('what-if-card')).toHaveCount(0);
  await expect(asha.page.getByTestId('what-if-label')).toHaveCount(0);
  await closeAll(asha.context);
});

test('on a desktop the card sits in the conversation beside the thread’s panel, labelled and checked', async ({
  browser,
}) => {
  const world = whatIfWorld();
  world.seedToday(1);
  world.bindScroll(world.nodes[0]!.nodeId);
  const asha = await person(browser, world, 'asha', desktop);
  const { page } = asha;
  const card = page.getByTestId('what-if-card');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('what-if-label')).toHaveText('What-if · made by KnowScroll');
  await expect(card.getByTestId('what-if-assumed')).toContainText(FIXTURE_ANSWER.assumption);
  await expect(card.getByRole('button', { name: 'Open', exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Branch again' })).toBeVisible();
  const box = await card.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(341);
  await shot(page, 'whatif-1440-ready');
  expect(await seriousViolations(page)).toEqual([]);
  await closeAll(asha.context);
});
