import { expect, test } from '@playwright/test';
import { conversation, talkFixture, thread } from './talk-fixture';

/**
 * D03 in the production export over labelled HTTP fixtures: a content thread and a direct
 * conversation beside their lists on a desktop, with the rail on tablets and desktops and no rail
 * on a phone. No backend.
 */
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
  await expect(page.getByRole('region', { name: 'Conversation' })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('link', { name: 'Keep', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: 'CI series' })).toBeVisible();
});
