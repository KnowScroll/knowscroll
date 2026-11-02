import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { conversation, talkFixture, thread } from './talk-fixture';

/**
 * D03 in the production export over labelled HTTP fixtures: a content thread and a direct
 * conversation beside their lists on a desktop, with the rail on tablets and desktops and no rail
 * on a phone. No backend.
 */
const playableVideo = readFileSync(join(__dirname, 'fixtures', 'blue-60s.webm'));

/** Windows either side of 1024 px, crossed in both directions. */
const crossings = [
  { width: 900, height: 900 },
  { width: 1440, height: 900 },
  { width: 1023, height: 700 },
  { width: 1280, height: 800 },
] as const;

/** Screenshots are written only when `KS_TALK_SHOTS` names a folder (outside the repository). */
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
      targets: violation.nodes.slice(0, 3).map((node) => `${node.target.join(' ')} ${node.html.slice(0, 120)}`),
    }));
}

const threadAddress = `/threads/${thread.threadId}?m=${thread.membershipId}&r=1`;
const conversationAddress = `/conversations/${conversation.conversationId}?m=${conversation.membershipId}&r=1`;

test('on a desktop the conversation sits beside the thread panel, with the rail and Talk current', async ({ page }) => {
  await talkFixture(page, { width: 1440, height: 900 });
  await page.goto(threadAddress);
  const pane = page.getByRole('region', { name: 'Thread' });
  const talk = page.getByRole('region', { name: 'Conversation' });
  await expect(page.getByRole('heading', { level: 1, name: 'CI series' })).toBeVisible();
  await expect(talk.getByText('That last part surprised me.')).toBeVisible();
  const left = await talk.boundingBox();
  const right = await pane.boundingBox();
  if (!left || !right) throw new Error('Both panes are measurable');
  expect(left.x + left.width).toBeLessThanOrEqual(right.x + 1);
  expect(Math.abs(left.y - right.y)).toBeLessThanOrEqual(1);
  await expect(page.getByRole('link', { name: 'Talk', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('main')).toHaveCount(1);
});

test('a conversation keeps the inbox beside it, with its own row current', async ({ page }) => {
  await talkFixture(page, { width: 1440, height: 900 });
  await page.goto(conversationAddress);
  const inbox = page.getByRole('complementary', { name: 'Conversations' });
  await expect(inbox.getByRole('link', { name: /^Ravi fixture/ })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('Starting the second part now.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Talk', exact: true })).toHaveAttribute('aria-current', 'page');
});

test('the Talk tab on a desktop has a pane for the chosen conversation', async ({ page }) => {
  await talkFixture(page, { width: 1440, height: 900 });
  await page.goto('/conversations');
  await expect(page.getByRole('link', { name: /^Ravi fixture/ })).toBeVisible();
  await expect(page.getByText('Pick a conversation')).toBeVisible();
  await page.getByRole('link', { name: /^Ravi fixture/ }).click();
  await expect(page.getByText('Starting the second part now.')).toBeVisible();
});

test('a tablet has the rail on a thread and a phone has none', async ({ page }) => {
  await talkFixture(page, { width: 834, height: 1112 });
  await page.goto(threadAddress);
  await expect(page.getByRole('heading', { level: 1, name: 'CI series' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Keep', exact: true })).toBeVisible();
  // One column: the conversation is under the thread, not beside it.
  const above = await page.getByRole('region', { name: 'Thread' }).boundingBox();
  const below = await page.getByRole('region', { name: 'Conversation' }).boundingBox();
  if (!above || !below) throw new Error('Both parts are measurable');
  expect(below.y).toBeGreaterThanOrEqual(above.y + above.height - 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('link', { name: 'Keep', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: 'CI series' })).toBeVisible();
});

test('crossing 1024 px keeps the thread: the same player and exposure, playback going, the draft and focus in the message box', async ({
  page,
}) => {
  const { calls } = await talkFixture(page, { width: 1440, height: 900 });
  await page.route('**/media/talk-fixture', (route) =>
    route.fulfill({ status: 200, contentType: 'video/webm', body: playableVideo }),
  );
  await page.goto(threadAddress);
  await expect(page.getByRole('heading', { level: 1, name: 'CI series' })).toBeVisible();
  await page.getByRole('button', { name: 'Watch', exact: true }).click();
  await expect(page.locator('video')).toHaveCount(1);
  const video = await page.locator('video').elementHandle();
  if (!video) throw new Error('The thread player mounts its video');
  const playing = () => page.locator('video').evaluate((node) => !(node as HTMLVideoElement).paused);
  if (!(await playing())) await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(playing).toBe(true);
  const count = (path: string) => calls.filter((call) => call.path === path).length;
  expect([count('/v1/experience/open'), count('/v1/experience/activate')]).toEqual([1, 1]);

  const box = page.getByRole('textbox', { name: /^Message/ });
  await box.fill('a draft that must survive');
  await box.focus();
  const reads = count('/v1/social/threads/read');
  const time = () => page.locator('video').evaluate((node) => (node as HTMLVideoElement).currentTime);
  for (const size of crossings) {
    const before = await time();
    await page.setViewportSize(size);
    await expect(page.getByRole('heading', { level: 1, name: 'CI series' })).toBeVisible();
    expect(await page.locator('video').evaluate((node, original) => node === original, video)).toBe(true);
    await expect.poll(time, { message: `advancing at ${String(size.width)} px` }).toBeGreaterThan(before);
    expect(await playing()).toBe(true);
    expect([count('/v1/experience/open'), count('/v1/experience/activate')]).toEqual([1, 1]);
    await expect(box).toHaveValue('a draft that must survive');
    await expect(box).toBeFocused();
  }
  expect(count('/v1/social/threads/read')).toBe(reads);
});

test('crossing 1024 px keeps the open conversation: one read, the draft and focus in the message box', async ({
  page,
}) => {
  const { calls } = await talkFixture(page, { width: 1440, height: 900 });
  await page.goto(conversationAddress);
  await expect(page.getByText('Starting the second part now.')).toBeVisible();
  const box = page.getByRole('textbox', { name: /^Message/ });
  await box.fill('still typing');
  await box.focus();
  const count = (path: string) => calls.filter((call) => call.path === path).length;
  const reads = count('/v1/social/conversations/read');
  const marks = count('/v1/social/conversations/mark-read');
  expect(reads).toBe(1);
  for (const size of crossings) {
    await page.setViewportSize(size);
    await expect(page.getByText('Starting the second part now.')).toBeVisible();
    await expect(box).toHaveValue('still typing');
    await expect(box).toBeFocused();
    expect(count('/v1/social/conversations/read')).toBe(reads);
    expect(count('/v1/social/conversations/mark-read')).toBe(marks);
  }
});

test('a content thread keeps Talk’s list as its first column, grouped, with the thread’s own row and its part chip', async ({
  page,
}) => {
  await talkFixture(page, { width: 1440, height: 900 }, { listThread: true });
  await page.goto(threadAddress);
  await expect(page.getByRole('heading', { level: 1, name: 'CI series' })).toBeVisible();
  const list = page.getByRole('complementary', { name: 'Conversations' });
  await expect(list.getByText('THREADS')).toBeVisible();
  await expect(list.getByText('PEOPLE')).toBeVisible();
  await expect(list.getByRole('link', { name: /^Thread CI series/ })).toHaveAttribute('aria-current', 'page');
  await expect(list.getByText('Part 1 of 3')).toBeVisible();
  // The list is the first column, then the conversation, then the series panel.
  const listBox = await list.boundingBox();
  const chat = await page.getByRole('region', { name: 'Conversation' }).boundingBox();
  const panel = await page.getByRole('region', { name: 'Thread' }).boundingBox();
  if (!listBox || !chat || !panel) throw new Error('The three columns are measurable');
  expect(listBox.x + listBox.width).toBeLessThanOrEqual(chat.x + 1);
  expect(chat.x + chat.width).toBeLessThanOrEqual(panel.x + 1);
  // Each part is a painted world, not a number.
  await expect(page.getByTestId('part-worlds').getByTestId('painted-world')).toHaveCount(3);
  await shot(page, 'thread-1440-columns');
  expect(await seriousViolations(page)).toEqual([]);
});

test('a conversation on a desktop has the "In this chat" rail: what was shared, and a thread to start from it', async ({
  page,
}) => {
  await talkFixture(page, { width: 1440, height: 900 }, { sharedCard: true, listThread: true });
  await page.goto(conversationAddress);
  const rail = page.getByRole('complementary', { name: 'In this chat' });
  await expect(rail.getByText('SHARED HERE · 1')).toBeVisible();
  await expect(rail.getByText('CI why the Moon and Sun make tides')).toBeVisible();
  await expect(rail.getByRole('button', { name: 'Start a thread from this' })).toBeVisible();
  await expect(rail.getByRole('button', { name: /^Visit Ravi fixture/ })).toBeVisible();
  await shot(page, 'dm-1440-rail');
  expect(await seriousViolations(page)).toEqual([]);
  await rail.getByRole('button', { name: 'Start a thread from this' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('a phone conversation has no rail, and opens with the "New since you were here" line over what the other person sent', async ({
  page,
}) => {
  await talkFixture(page, { width: 390, height: 844 }, { sharedCard: true });
  await page.goto(conversationAddress);
  await expect(page.getByText('NEW SINCE YOU WERE HERE')).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'In this chat' })).toHaveCount(0);
  await shot(page, 'dm-390-new-since');
  expect(await seriousViolations(page)).toEqual([]);
});

test('a conversation the person wrote in but never opened still draws "New since you were here" over the reply (#648)', async ({
  page,
}) => {
  // Their message 1 went out from a share sheet, so no read position was ever stored (0); Ravi answered with 2.
  await talkFixture(page, { width: 390, height: 844 }, { readThrough: 0 });
  await page.goto(conversationAddress);
  await expect(page.getByText('NEW SINCE YOU WERE HERE')).toBeVisible();
  await shot(page, 'dm-390-new-since-never-opened');
  expect(await seriousViolations(page)).toEqual([]);
});

test('at 1024 px the chat keeps its room: a thread has no list column and a conversation has no rail', async ({
  page,
}) => {
  await talkFixture(page, { width: 1024, height: 800 }, { sharedCard: true, listThread: true });
  await page.goto(threadAddress);
  await expect(page.getByRole('heading', { level: 1, name: 'CI series' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Conversations' })).toHaveCount(0);
  const threadChat = await page.getByRole('region', { name: 'Conversation' }).boundingBox();
  expect(threadChat!.width).toBeGreaterThanOrEqual(400);

  await page.goto(conversationAddress);
  await expect(page.getByText('Starting the second part now.')).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'In this chat' })).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Conversations' })).toBeVisible();
  const messages = await page.getByRole('textbox', { name: /^Message/ }).boundingBox();
  expect(messages!.width).toBeGreaterThanOrEqual(400 - 2 * 20);
  await shot(page, 'dm-1024-no-rail');
});

test('at 1280 px a thread has the list column and a conversation the rail, each chat wide enough to read', async ({
  page,
}) => {
  await talkFixture(page, { width: 1280, height: 800 }, { sharedCard: true, listThread: true });
  await page.goto(threadAddress);
  await expect(page.getByRole('complementary', { name: 'Conversations' })).toBeVisible();
  const threadChat = await page.getByRole('region', { name: 'Conversation' }).boundingBox();
  expect(threadChat!.width).toBeGreaterThanOrEqual(360);
  await page.goto(conversationAddress);
  await expect(page.getByRole('complementary', { name: 'In this chat' })).toBeVisible();
  const rail = await page.getByRole('complementary', { name: 'In this chat' }).boundingBox();
  const list = await page.getByRole('complementary', { name: 'Conversations' }).boundingBox();
  expect(rail!.x - (list!.x + list!.width)).toBeGreaterThanOrEqual(400);
});

test('a thread and a conversation never scroll sideways at 320 px', async ({ page }) => {
  await talkFixture(page, { width: 320, height: 568 }, { sharedCard: true, listThread: true });
  for (const address of [threadAddress, conversationAddress]) {
    await page.goto(address);
    await expect(page.getByRole('textbox', { name: /^Message/ })).toBeVisible();
    const sideways = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(sideways, address).toBeLessThanOrEqual(0);
  }
});
