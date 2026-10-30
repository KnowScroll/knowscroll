import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { talkFixture, thread } from './talk-fixture';

const playableVideo = readFileSync(join(__dirname, 'fixtures', 'blue-60s.webm'));

/**
 * T3 on a phone (#481): over labelled HTTP fixtures a content thread keeps most of the screen for the
 * conversation, pulls its parts down from a 72 px header as a sheet that Back closes first, and dates
 * and times the messages. No backend.
 */
const threadAddress = `/threads/${thread.threadId}?m=${thread.membershipId}&r=1`;
const PHONE = { width: 390, height: 844 };

async function box(page: Page, locator: ReturnType<Page['locator']>) {
  const found = await locator.boundingBox();
  if (!found) throw new Error('The part is measurable');
  return found;
}

test('on a phone the conversation keeps at least 60 percent of the screen beside the header and the docked player', async ({
  page,
}) => {
  await talkFixture(page, PHONE);
  await page.goto(threadAddress);
  await expect(page.getByRole('heading', { level: 1, name: 'CI series' })).toBeVisible();
  const dock = page.getByTestId('thread-dock');
  await expect(dock).toBeVisible();

  const header = await box(page, page.getByTestId('thread-header'));
  const dockBox = await box(page, dock);
  const messages = await box(page, page.getByTestId('thread-messages'));
  const conversation = await box(page, page.getByRole('region', { name: 'Conversation' }));

  expect(header.height).toBeLessThanOrEqual(72 + 1);
  expect(dockBox.height).toBeGreaterThanOrEqual(56);
  expect(dockBox.height).toBeLessThanOrEqual(57 + 1);
  // The messages alone, and the whole conversation (messages, asks, message box), as shares of the screen.
  const messagesShare = messages.height / PHONE.height;
  const conversationShare = conversation.height / PHONE.height;
  // eslint-disable-next-line no-console -- the measurement is the evidence the slice reports
  console.log(
    `thread at 390x844: header ${String(header.height)} px, dock ${String(dockBox.height)} px, messages ${String(messages.height)} px (${(messagesShare * 100).toFixed(1)} %), conversation region ${String(conversation.height)} px (${(conversationShare * 100).toFixed(1)} %)`,
  );
  expect(messagesShare).toBeGreaterThanOrEqual(0.6);
  expect(conversationShare).toBeGreaterThanOrEqual(0.6);
  await page.screenshot({ path: process.env['KS_SHOTS'] ? `${process.env['KS_SHOTS']}/thread-390.png` : undefined });
});

test('the Series sheet hangs from the header, closes with Back before the thread is left, and picking a part closes it', async ({
  page,
}) => {
  await talkFixture(page, PHONE);
  await page.goto(threadAddress);
  await expect(page.getByRole('heading', { level: 1, name: 'CI series' })).toBeVisible();
  const series = page.getByTestId('thread-series-button');
  await series.click();
  const sheet = page.getByRole('dialog', { name: 'A SERIES · 3 PARTS' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: /^Part 1, CI part 1/ })).toBeVisible();
  await expect(sheet.getByRole('button', { name: /^Part 3, CI part 3/ })).toBeVisible();
  if (process.env['KS_SHOTS']) {
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${process.env['KS_SHOTS']}/thread-390-series.png` });
  }

  // Browser Back closes the sheet and leaves the thread where it was.
  await page.goBack();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: 'CI series' })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(`/threads/${thread.threadId}`);

  // Esc and Close do the same; choosing a part moves this device's own place and closes the sheet.
  await series.click();
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await series.click();
  await sheet.getByRole('button', { name: /^Part 2, CI part 2/ }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Open Part 2 of 3, CI part 2/ })).toBeVisible();
});

test('arrow keys in the Series sheet move the selection and leave the sheet open', async ({ page }) => {
  await talkFixture(page, PHONE);
  await page.goto(threadAddress);
  await page.getByTestId('thread-series-button').click();
  const sheet = page.getByRole('dialog', { name: 'A SERIES · 3 PARTS' });
  const part = (number: number) => sheet.getByRole('button', { name: new RegExp(`^Part ${String(number)},`) });
  await part(1).focus();
  await page.keyboard.press('ArrowDown');
  await expect(sheet).toBeVisible();
  await expect(part(2)).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ArrowUp');
  await expect(sheet).toBeVisible();
  await expect(part(1)).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ArrowDown');
  await part(2).press('Enter');
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Open Part 2 of 3, CI part 2/ })).toBeVisible();
});

test('resizing to a desktop with the Series sheet open does not leave the player paused', async ({ page }) => {
  await talkFixture(page, PHONE);
  await page.route('**/media/talk-fixture', (route) =>
    route.fulfill({ status: 200, contentType: 'video/webm', body: playableVideo }),
  );
  await page.goto(threadAddress);
  await page.getByTestId('thread-series-button').click();
  await expect(page.getByRole('dialog', { name: 'A SERIES · 3 PARTS' })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Watch', exact: true }).click();
  await expect(page.locator('video')).toHaveCount(1);
  const playing = () => page.locator('video').evaluate((node) => !(node as HTMLVideoElement).paused);
  if (!(await playing())) await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(playing).toBe(true);
});

test('pressing the dock opens the player in place, and folding docks it again', async ({ page }) => {
  await talkFixture(page, PHONE);
  await page.goto(threadAddress);
  const dock = page.getByTestId('thread-dock');
  await expect(dock).toBeVisible();
  await expect(page.getByRole('button', { name: 'Watch', exact: true })).toBeHidden();
  await page.getByRole('button', { name: /^Open Part 1 of 3, CI part 1/ }).click();
  await expect(dock).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Watch', exact: true })).toBeVisible();
  if (process.env['KS_SHOTS']) await page.screenshot({ path: `${process.env['KS_SHOTS']}/thread-390-open.png` });
  await page.getByRole('button', { name: 'Fold the player' }).click();
  await expect(dock).toBeVisible();
});

test('messages are dated by day and timed by run, and nobody is shown watching or on a part', async ({ page }) => {
  await talkFixture(page, PHONE);
  await page.goto(threadAddress);
  await expect(page.getByText('That last part surprised me.')).toBeVisible();
  const times = page.getByTestId('message-time');
  await expect(times).toHaveCount(3);
  for (const time of await times.allTextContents()) expect(time).toMatch(/\d{1,2}:\d{2}/);
  // One capsule for the day, in words (the fixture's messages are all of one October day, long past).
  await expect(page.getByText(/^(\d{1,2} Oct|Oct \d{1,2})(,? 2026)?$/)).toHaveCount(1);
  // Nothing in the page says where anyone else is; the Series sheet, too, only names the parts and the people.
  const nobodyPlaced = /watching|(?:is|are) on part/i;
  expect(await page.locator('body').innerText()).not.toMatch(nobodyPlaced);
  await page.getByTestId('thread-series-button').click();
  await expect(page.getByRole('dialog', { name: 'A SERIES · 3 PARTS' })).toBeVisible();
  expect(await page.getByRole('dialog', { name: 'A SERIES · 3 PARTS' }).innerText()).not.toMatch(nobodyPlaced);
});

test('on a desktop the series panel sits beside the conversation with the parts, the player and the people', async ({
  page,
}) => {
  await talkFixture(page, { width: 1440, height: 900 });
  await page.goto(threadAddress);
  const panel = page.getByRole('region', { name: 'Thread' });
  const talk = page.getByRole('region', { name: 'Conversation' });
  await expect(page.getByRole('heading', { level: 1, name: 'CI series' })).toBeVisible();
  await expect(panel.getByRole('button', { name: /^Part 1, CI part 1/ })).toBeVisible();
  await expect(panel.getByRole('button', { name: /^Part 3, CI part 3/ })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Watch', exact: true })).toBeVisible();
  await expect(panel.getByText('Ravi fixture')).toBeVisible();
  await expect(page.getByTestId('thread-series-button')).toHaveCount(0);
  const left = await box(page, talk);
  const right = await box(page, panel);
  expect(left.x + left.width).toBeLessThanOrEqual(right.x + 1);
  expect(right.width).toBeGreaterThanOrEqual(380);
  expect(Math.abs(left.y - right.y)).toBeLessThanOrEqual(1);
  if (process.env['KS_SHOTS']) await page.screenshot({ path: `${process.env['KS_SHOTS']}/thread-1440.png` });
});
