import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { openPair, pairWorld, type PairWorld, type Who } from './talk-pair-fixture';

/**
 * T3 Talk in the production export: two people in one conversation over labelled HTTP fixtures (no
 * backend), each in their own browser context. Bubbles, day capsules and the time under a run; swipe to
 * reply (touch only) with a quote that jumps; the long-press menu and the five reactions with who; the keys
 * R and E; and axe at a phone and a desktop width. Screenshots are written only when `KS_TALK_SHOTS` names a folder.
 */
const phone = { width: 390, height: 844 };
const desktop = { width: 1440, height: 900 };

/** A long conversation: the first message is far above what a phone shows at the end. */
function conversation(): PairWorld {
  const world = pairWorld();
  // Day capsules depend on the calendar day, so the fixture is anchored to today's midnight, not to
  // 'now': yesterday's two messages sit at yesterday noon, and today's never cross back over midnight.
  const now = new Date();
  const sinceMidnight = Math.floor(
    (now.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 60_000,
  );
  const today = (minutes: number) => Math.min(minutes, sinceMidnight);
  world.say('ravi', 'part 1 dekha?', { minutesAgo: sinceMidnight + 12 * 60 });
  world.say('asha', 'haan, moon ka bulge samajh aaya', { minutesAgo: sinceMidnight + 12 * 60 - 1 });
  for (let n = 0; n < 14; n++) {
    world.say(n % 2 === 0 ? 'ravi' : 'asha', `filler message ${String(n + 1)} to push the first ones out of view`, {
      minutesAgo: today(90 - n * 5),
    });
  }
  world.say('ravi', 'who is on part 2?', { minutesAgo: today(3) });
  world.say('ravi', 'asking again, the far side bulge?', { minutesAgo: today(2) });
  return world;
}

async function person(browser: Browser, world: PairWorld, who: Who, viewport = phone, reducedMotion = false) {
  const context = await browser.newContext({
    viewport,
    hasTouch: true,
    reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
  });
  const page = await context.newPage();
  await openPair(page, world, who, viewport);
  await expect(page.getByTestId('conversation-messages')).toBeVisible();
  return { context, page };
}

/** A swipe to the right with a real touch, through the browser's own input pipeline. */
async function swipeRight(page: Page, bubble: Locator, distance: number) {
  const box = await bubble.boundingBox();
  if (!box) throw new Error('The bubble is measurable');
  const y = box.y + box.height / 2;
  const from = box.x + 24;
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from, y }] });
  for (const step of [0.25, 0.5, 0.75, 1])
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: from + distance * step, y }],
    });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function longPress(page: Page, target: Locator) {
  const box = await target.boundingBox();
  if (!box) throw new Error('The target is measurable');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(550);
  await page.mouse.up();
}

/** The bubble that says exactly this (a reply's quote repeats the words, so bubbles holding a quote are left out). */
const bubbleOf = (page: Page, text: string) =>
  page
    .locator('[data-testid^="bubble-"]')
    .filter({ hasText: text })
    .filter({ hasNot: page.getByTestId('quote-strip') });

async function shot(page: Page, name: string) {
  const folder = process.env['KS_TALK_SHOTS'];
  if (folder === undefined) return;
  mkdirSync(folder, { recursive: true });
  // Sheets and menus fade in; a frame taken mid-fade is not what a person sees.
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

test('dark bubbles, a capsule for each day and the time under each run, in the Talk look', async ({ browser }) => {
  const world = conversation();
  const asha = await person(browser, world, 'asha');
  const { page } = asha;
  await expect(page.getByRole('heading', { name: 'Yesterday' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  // Another person is paper and ink, you are cobalt; the sky is behind both.
  await expect(bubbleOf(page, 'who is on part 2?')).toHaveCSS('background-color', 'rgb(255, 253, 242)');
  await expect(bubbleOf(page, 'asking again, the far side bulge?')).toHaveCSS('background-color', 'rgb(255, 253, 242)');
  await expect(page.getByTestId('conversation-messages')).toHaveCSS('background-color', 'rgb(2, 3, 8)');
  // Two messages by one person within five minutes are one run: the time sits under the second only.
  const times = page.getByTestId('message-time');
  await expect(times.last()).toBeVisible();
  const count = await times.count();
  expect(count).toBeGreaterThan(2);
  await shot(page, 'dm-phone-asha');
  await closeAll(asha.context);
});

test('swipe right replies with a touch, never with a mouse, and the reply quotes its original and jumps back to it', async ({
  browser,
}) => {
  const world = conversation();
  const asha = await person(browser, world, 'asha');
  const ravi = await person(browser, world, 'ravi');
  const { page } = asha;
  const target = bubbleOf(page, 'who is on part 2?');
  await target.scrollIntoViewIfNeeded();

  // A mouse drag past 60 px is not a swipe.
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + 24, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 140, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId('reply-chip')).toHaveCount(0);
  // A short touch drag is not either.
  await swipeRight(page, target, 40);
  await expect(page.getByTestId('reply-chip')).toHaveCount(0);
  // A touch drag past 60 px is, and the chip waits above the box.
  await swipeRight(page, target, 90);
  const chip = page.getByTestId('reply-chip');
  await expect(chip).toContainText('Replying to Ravi fixture');
  await expect(chip).toContainText('who is on part 2?');
  await shot(page, 'dm-phone-asha-replying');
  const box1 = page.getByLabel('Message Ravi fixture');
  await box1.fill('part 2 abhi start kiya');
  await box1.press('Enter');
  await expect(chip).toHaveCount(0);
  expect(world.replyOf(world.messages.length)).toBe(world.messages.length - 2);

  // The reply carries the quote; the other person reads it as a quote of their own words.
  await ravi.page.reload();
  const quote = ravi.page.getByTestId('quote-strip').last();
  await expect(quote).toContainText('Ravi fixture');
  await expect(quote).toContainText('who is on part 2?');

  // Asha's quote jumps back to the original, which is far above, and lights it for a moment.
  const quoteOnAsha = page.getByTestId('quote-strip').last();
  await expect(quoteOnAsha).toBeVisible();
  const original = bubbleOf(page, 'who is on part 2?');
  await page.getByTestId('conversation-messages').evaluate((list) => list.scrollTo({ top: 0 }));
  await quoteOnAsha.scrollIntoViewIfNeeded();
  await quoteOnAsha.click();
  await expect(original).toBeInViewport();
  await expect(original).toHaveCSS('background-color', 'rgb(255, 236, 122)');
  await expect(original).not.toHaveCSS('background-color', 'rgb(255, 236, 122)', { timeout: 3_000 });
  await closeAll(asha.context, ravi.context);
});

test('reduced motion: no flash after a jump, a 2 px yellow outline stays for a while instead', async ({ browser }) => {
  const world = conversation();
  const asha = await person(browser, world, 'asha', phone, true);
  const { page } = asha;
  await page.getByLabel('Message Ravi fixture').fill('replying later');
  await page.getByTestId('conversation-messages').evaluate((list) => list.scrollTo({ top: 0 }));
  const first = bubbleOf(page, 'part 1 dekha?');
  await first.scrollIntoViewIfNeeded();
  await longPress(page, first);
  await page.getByRole('menuitem', { name: 'Reply' }).click();
  await page.getByLabel('Message Ravi fixture').fill('yes, watched it');
  await page.getByLabel('Message Ravi fixture').press('Enter');
  await page.getByTestId('quote-strip').last().click();
  await expect(first).toHaveCSS('border-top-width', '2px');
  await expect(first).toHaveCSS('border-top-color', 'rgb(255, 228, 77)');
  await expect(first).not.toHaveCSS('background-color', 'rgb(255, 236, 122)');
  await page.waitForTimeout(1_500);
  await expect(first).toHaveCSS('border-top-width', '2px');
  await closeAll(asha.context);
});

test('a long press opens the menu with five reactions; a reaction shows with a count, and a tap says who', async ({
  browser,
}) => {
  const world = conversation();
  const asha = await person(browser, world, 'asha');
  const ravi = await person(browser, world, 'ravi');
  const { page } = asha;
  const message = bubbleOf(page, 'asking again, the far side bulge?');
  await longPress(page, message);
  const menu = page.getByRole('dialog', { name: 'Message options' });
  await expect(menu).toBeVisible();
  for (const kind of ['Spark', 'Mind blown', 'Ha', 'Heart', 'Question'])
    await expect(menu.getByRole('button', { name: kind })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Reply' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Copy' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Report' })).toBeVisible();
  await shot(page, 'dm-phone-menu');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  await longPress(page, message);
  await page.getByRole('dialog', { name: 'Message options' }).getByRole('button', { name: 'Heart' }).click();
  const mine = page.getByRole('button', { name: 'Heart, 1 person, including you' });
  await expect(mine).toBeVisible();
  expect(world.reactionsOn(world.messages.length)).toEqual(['asha:heart']);

  // The other person reads it as one person, not including them, and sees who.
  await ravi.page.reload();
  const theirs = ravi.page.getByRole('button', { name: 'Heart, 1 person' });
  await expect(theirs).toBeVisible();
  await theirs.click();
  const sheet = ravi.page.getByRole('dialog', { name: 'Heart · 1' });
  await expect(sheet.getByText('Asha fixture')).toBeVisible();
  await shot(ravi.page, 'dm-phone-reactors-ravi');
  await sheet.getByRole('button', { name: 'Add your Heart' }).click();
  expect(world.reactionsOn(world.messages.length).sort()).toEqual(['asha:heart', 'ravi:heart']);

  // Back on Asha's side: two people, including her; she takes hers back, and one is left.
  await page.reload();
  await page.getByRole('button', { name: 'Heart, 2 people, including you' }).click();
  const list = page.getByRole('dialog', { name: 'Heart · 2' });
  await expect(list.getByText('You', { exact: true })).toBeVisible();
  await expect(list.getByText('Ravi fixture')).toBeVisible();
  await list.getByRole('button', { name: 'Take back your Heart' }).click();
  expect(world.reactionsOn(world.messages.length)).toEqual(['ravi:heart']);
  await closeAll(asha.context, ravi.context);
});

test('on a desktop, the keys work from the options button: R replies, E opens the menu, Esc cancels', async ({
  browser,
}) => {
  const world = conversation();
  const asha = await person(browser, world, 'asha', desktop);
  const { page } = asha;
  await shot(page, 'dm-desktop-asha');
  const options = page.getByRole('button', { name: 'Options for Ravi fixture’s message' }).last();
  await options.focus();
  await page.keyboard.press('r');
  await expect(page.getByTestId('reply-chip')).toContainText('Replying to Ravi fixture');
  await page.getByLabel('Message Ravi fixture').press('Escape');
  await expect(page.getByTestId('reply-chip')).toHaveCount(0);
  await options.focus();
  await page.keyboard.press('e');
  await expect(page.getByRole('dialog', { name: 'Message options' })).toBeVisible();
  await shot(page, 'dm-desktop-menu');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Message options' })).toHaveCount(0);
  await closeAll(asha.context);
});

test('axe finds nothing serious at 390 x 844 and 1440 x 900, with replies, reactions, the menu and the list of who open', async ({
  browser,
}) => {
  for (const viewport of [phone, desktop]) {
    const world = conversation();
    const target = world.say('asha', 'a reply with a quote', { replyTo: 1, minutesAgo: 1 });
    world.react('ravi', target, 'spark', true);
    world.react('asha', target, 'heart', true);
    const asha = await person(browser, world, 'asha', viewport);
    const { page } = asha;
    await expect(page.getByTestId('quote-strip').last()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Heart, 1 person, including you' })).toBeVisible();
    expect(await seriousViolations(page), `the list at ${String(viewport.width)}`).toEqual([]);
    await page.getByRole('button', { name: 'Spark, 1 person' }).click();
    await expect(page.getByRole('dialog', { name: 'Spark · 1' })).toBeVisible();
    await page.waitForTimeout(400);
    expect(await seriousViolations(page), `who reacted at ${String(viewport.width)}`).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Spark · 1' })).toHaveCount(0);
    await longPress(page, page.getByTestId(`bubble-${String(target)}`));
    await expect(page.getByRole('dialog', { name: 'Message options' })).toBeVisible();
    await page.waitForTimeout(400);
    expect(await seriousViolations(page), `the menu at ${String(viewport.width)}`).toEqual([]);
    await closeAll(asha.context);
  }
});
