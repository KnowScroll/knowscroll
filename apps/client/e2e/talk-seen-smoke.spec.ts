import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { openPair, pairAddress, pairWorld, type PairWorld, type Who } from './talk-pair-fixture';

/**
 * SEEN in a direct conversation and the Paper theme (v3 T-C, D-066, D-150, D-151) in the production export: two
 * people in one conversation over labelled HTTP fixtures (no backend), each in their own browser context. The
 * fixture keeps the real server's rule: each person's read position moves by their own mark-read, and the other
 * person is told how far only while both people's switches are on. Screenshots are written only when
 * `KS_TALK_SHOTS` names a folder.
 */
const phone = { width: 390, height: 844 };
const desktop = { width: 1440, height: 900 };

/** Ravi, then Asha, then Ravi again: each has an own latest message, and everything is from the last few minutes. */
function conversation(): PairWorld {
  const world = pairWorld();
  world.say('ravi', 'part 1 dekha?', { minutesAgo: 30 });
  world.say('asha', 'haan, moon ka bulge samajh aaya', { minutesAgo: 20 });
  world.say('ravi', 'aur jab dono line mein hote hain, tides max', { minutesAgo: 10 });
  return world;
}

async function person(
  browser: Browser,
  world: PairWorld,
  who: Who,
  viewport = phone,
  preferences?: Record<string, unknown>,
) {
  const context = await browser.newContext({ viewport, hasTouch: true });
  if (preferences !== undefined)
    await context.addInitScript(
      (value) => window.localStorage.setItem('ks.device.preferences', value),
      JSON.stringify(preferences),
    );
  const page = await context.newPage();
  await openPair(page, world, who, viewport);
  await expect(page.getByTestId('conversation-messages')).toBeVisible();
  return { context, page };
}

async function shot(page: Page, name: string) {
  const folder = process.env['KS_TALK_SHOTS'];
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

/** The word under the person's own latest message: the time, then Sent or Seen. Nothing else carries one. */
async function deliveryUnder(page: Page): Promise<string[]> {
  await expect(page.getByTestId('message-time').last()).toBeVisible();
  const labels = await page.getByTestId('message-time').allInnerTexts();
  return labels.flatMap((label) => (/\b(sent|seen)\b/i.exec(label) ?? []).slice(1)).map((word) => word.toLowerCase());
}

test('SEEN shows under the latest own message once the other person has read it, on the sent time, and nowhere else', async ({
  browser,
}) => {
  const world = conversation();
  const asha = await person(browser, world, 'asha');
  // Asha read to the end on opening. Ravi has not opened it: her latest message is Sent.
  await expect.poll(() => world.readThrough('asha')).toBe(3);
  await expect(asha.page.getByTestId('message-time').filter({ hasText: /Sent/i })).toHaveCount(1);
  expect(await deliveryUnder(asha.page)).toEqual(['sent']);

  // Ravi opens the conversation and reads to the end; her next read is told how far.
  const ravi = await person(browser, world, 'ravi');
  await expect.poll(() => world.readThrough('ravi')).toBe(3);
  await asha.page.reload();
  const seen = asha.page.getByTestId('message-time').filter({ hasText: /Seen/i });
  await expect(seen).toHaveCount(1);
  await expect(seen).toHaveText(/^\d{1,2}:\d{2}(\s?[AP]M)?\s*·\s*Seen$/i);
  expect(await deliveryUnder(asha.page)).toEqual(['seen']);
  // The word is drawn in capitals by the type role, as T3 draws it, and is read as a word.
  await expect(seen).toHaveCSS('text-transform', 'uppercase');
  await shot(asha.page, 'dm-phone-seen');

  // Ravi's own latest message is Seen too: Asha read to the end as well. Nobody is told of typing.
  expect(await deliveryUnder(ravi.page)).toEqual(['seen']);
  await expect(asha.page.getByText(/typing/i)).toHaveCount(0);
  await closeAll(asha.context, ravi.context);
});

test('SEEN works both ways: when either person hides theirs, neither sees the other’s, and it returns when they show it', async ({
  browser,
}) => {
  const world = conversation();
  const asha = await person(browser, world, 'asha');
  const ravi = await person(browser, world, 'ravi');
  await expect.poll(() => world.readThrough('ravi')).toBe(3);
  const both = async () => {
    await asha.page.reload();
    await ravi.page.reload();
    await expect(asha.page.getByTestId('message-time').last()).toBeVisible();
    await expect(ravi.page.getByTestId('message-time').last()).toBeVisible();
    return [await deliveryUnder(asha.page), await deliveryUnder(ravi.page)];
  };
  expect(await both()).toEqual([['seen'], ['seen']]);

  // Asha hides hers: she does not see Ravi's, and Ravi does not see hers. Her own reading still moves.
  world.setSeen('asha', false);
  expect(await both()).toEqual([['sent'], ['sent']]);
  expect(world.readThrough('asha')).toBe(3);
  world.setSeen('asha', true);
  expect(await both()).toEqual([['seen'], ['seen']]);

  // Ravi hides his: the same, the other way round. Nothing on the page says who hid theirs.
  world.setSeen('ravi', false);
  expect(await both()).toEqual([['sent'], ['sent']]);
  await expect(asha.page.getByText(/hidden|hid |turned off|read receipts/i)).toHaveCount(0);
  await closeAll(asha.context, ravi.context);
});

test('what a person read while theirs was hidden stays Sent after they show it again, and a new read while sharing shows', async ({
  browser,
}) => {
  const world = conversation();
  const asha = await person(browser, world, 'asha');
  const ravi = await person(browser, world, 'ravi');
  await expect.poll(() => world.readThrough('ravi')).toBe(3);
  // Ravi hides his, and Asha sends something he reads while it is hidden.
  world.setSeen('ravi', false);
  world.say('asha', 'ruk, saath mein dekhte hain', { minutesAgo: 2 });
  await ravi.page.reload();
  await expect.poll(() => world.readThrough('ravi')).toBe(4);
  expect(world.sharedThrough('ravi')).toBe(3);
  world.setSeen('ravi', true);
  await asha.page.reload();
  expect(await deliveryUnder(asha.page)).toEqual(['sent']);
  // A new message, read while he shares: shown.
  world.say('asha', 'part 2 abhi start kiya', { minutesAgo: 1 });
  await ravi.page.reload();
  await expect.poll(() => world.sharedThrough('ravi')).toBe(5);
  await asha.page.reload();
  expect(await deliveryUnder(asha.page)).toEqual(['seen']);
  await closeAll(asha.context, ravi.context);
});

test('a message the other person has not read to stays Sent, and an older own message never carries the word', async ({
  browser,
}) => {
  const world = conversation();
  // Asha sends two more; Ravi has read only to the first of them.
  world.say('asha', 'ruk, saath mein dekhte hain', { minutesAgo: 5 });
  const asha = await person(browser, world, 'asha');
  const ravi = await person(browser, world, 'ravi');
  await expect.poll(() => world.readThrough('ravi')).toBe(4);
  world.say('asha', 'part 2 abhi start kiya', { minutesAgo: 1 });
  await asha.page.reload();
  // Two own messages are on the page; only the latest carries Sent, and Ravi's read does not reach it.
  expect(await deliveryUnder(asha.page)).toEqual(['sent']);
  await closeAll(asha.context, ravi.context);
});

test('Paper is chosen in Account, applies to the conversation at once and is kept on this device', async ({
  browser,
}) => {
  const world = conversation();
  const asha = await person(browser, world, 'asha');
  const { page } = asha;
  // The dark sky first: the ground is the sky.
  await expect(page.getByTestId('conversation-messages')).toHaveCSS('background-color', 'rgb(2, 3, 8)');

  await page.goto('/account/accessibility');
  await expect(page.getByRole('radio', { name: 'Dark sky' })).toBeChecked();
  await page.getByRole('radio', { name: 'Paper' }).click();
  await expect(page.getByRole('radio', { name: 'Paper' })).toBeChecked();
  expect(await page.evaluate(() => window.localStorage.getItem('ks.device.preferences'))).toContain(
    '"talkTheme":"paper"',
  );

  await page.goto(pairAddress('asha'));
  await expect(page.getByTestId('conversation-messages')).toHaveCSS('background-color', 'rgb(244, 237, 216)');
  await shot(page, 'dm-phone-paper');
  // Own bubbles stay cobalt on Paper, and another person's stay paper and ink.
  await expect(
    page.locator('[data-testid^="bubble-"]').filter({ hasText: 'haan, moon ka bulge samajh aaya' }),
  ).toHaveCSS('background-color', 'rgb(44, 70, 232)');
  await closeAll(asha.context);
});

test('axe finds nothing serious with SEEN showing, on the dark sky and on Paper, at 390 x 844 and 1440 x 900', async ({
  browser,
}) => {
  for (const viewport of [phone, desktop])
    for (const theme of ['sky', 'paper'] as const) {
      const world = conversation();
      const asha = await person(browser, world, 'asha', viewport, { talkTheme: theme });
      const ravi = await person(browser, world, 'ravi', viewport, { talkTheme: theme });
      await expect.poll(() => world.readThrough('ravi')).toBe(3);
      await asha.page.reload();
      await expect(asha.page.getByTestId('message-time').filter({ hasText: /Seen/i })).toHaveCount(1);
      expect(await seriousViolations(asha.page), `${theme} at ${String(viewport.width)}`).toEqual([]);
      await shot(asha.page, `dm-${viewport.width === 390 ? 'phone' : 'desktop'}-${theme}-seen`);
      await closeAll(asha.context, ravi.context);
    }
});

test('reduced motion changes nothing about SEEN: it is words under a message, with no animation', async ({
  browser,
}) => {
  const world = conversation();
  const context = await browser.newContext({ viewport: phone, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await openPair(page, world, 'asha', phone);
  const ravi = await person(browser, world, 'ravi');
  await expect.poll(() => world.readThrough('ravi')).toBe(3);
  await page.reload();
  const seen = page.getByTestId('message-time').filter({ hasText: /Seen/i });
  await expect(seen).toHaveCount(1);
  await expect(seen).toHaveCSS('transition-duration', '0s');
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  await closeAll(context, ravi.context);
});
