import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
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

const threadAddress = `/threads/${thread.threadId}?m=${thread.membershipId}&r=1`;
const conversationAddress = `/conversations/${conversation.conversationId}?m=${conversation.membershipId}&r=1`;

test('on a desktop the thread and its conversation sit side by side, with the rail and Talk current', async ({
  page,
}) => {
  await talkFixture(page, { width: 1440, height: 900 });
  await page.goto(threadAddress);
  const pane = page.getByRole('region', { name: 'Thread' });
  const talk = page.getByRole('region', { name: 'Conversation' });
  await expect(pane.getByRole('heading', { level: 1, name: 'CI series' })).toBeVisible();
  await expect(talk.getByText('That last part surprised me.')).toBeVisible();
  const left = await pane.boundingBox();
  const right = await talk.boundingBox();
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
