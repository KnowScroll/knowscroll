import { expect, test } from '@playwright/test';
import { encounterFixture } from './encounter-fixture';

/**
 * D01 and V01 in the production export over labelled HTTP fixtures: the desktop Reel as a card with
 * its controls around it and the thread beside it, the thread beside a Scroll on a tablet, and a
 * phone with neither. No decoded playback is claimed.
 */

const intents = (commands: { path: string; body: Record<string, unknown> }[]) =>
  commands.filter((call) => call.path === '/v1/experience/navigate').map((call) => call.body['intent']);

test('a desktop Reel is a card with Previous subject, the actions and Next subject around it, and the thread beside it', async ({
  page,
}) => {
  const { commands } = await encounterFixture(page, 'reel', { viewport: { width: 1440, height: 900 }, series: true });
  await page.route('**/media/gesture-fixture', (route) => route.fulfill({ status: 404, body: 'fixture only' }));
  await page.goto('/explore');
  await expect(page.getByTestId('explore-desktop-frame')).toBeVisible();
  const thread = page.getByRole('complementary', { name: 'This thread' });
  await expect(thread.getByRole('button', { name: 'Continue: Part 2, CI series part 2' })).toBeVisible();
  await expect(thread.getByRole('button', { name: /^Another related explanation/ })).toBeVisible();
  await expect(thread.getByText('Part 1')).toBeVisible();
  // The card is a 9:16 stage at most 480 px wide, inside the window.
  const card = await page.getByTestId('reel-video-stage').boundingBox();
  if (!card) throw new Error('The Reel card is measurable');
  expect(card.width).toBeLessThanOrEqual(481);
  expect(card.height).toBeGreaterThan(560);
  expect(card.y + card.height).toBeLessThanOrEqual(900);

  // Next subject, and the arrow keys on the focused stage, are the same vertical move as a swipe.
  await page.getByRole('button', { name: 'Next subject' }).click();
  await expect.poll(() => intents(commands)).toEqual([{ mode: 'vertical', direction: 'next' }]);
  await expect(page.getByTestId('encounter-reel-caption')).toContainText('CI encounter fixture 2');
  await page.getByTestId('reel-navigation-stage').focus();
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => intents(commands).length).toBe(2);
  await expect(page.getByTestId('encounter-reel-caption')).toContainText('CI encounter fixture 3');
  await page.getByTestId('reel-navigation-stage').focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => intents(commands).at(-1)).toMatchObject({ mode: 'series', direction: 'next' });
});

test('the thread beside the encounter opens the next part', async ({ page }) => {
  const { commands } = await encounterFixture(page, 'scroll', { viewport: { width: 1440, height: 900 }, series: true });
  await page.goto('/explore');
  const thread = page.getByRole('complementary', { name: 'This thread' });
  await thread.getByRole('button', { name: 'Continue: Part 2, CI series part 2' }).click();
  await expect.poll(() => intents(commands)).toMatchObject([{ mode: 'series', direction: 'next' }]);
});

test('a tablet keeps the thread beside a Scroll and a phone keeps it out of the way', async ({ page }) => {
  await encounterFixture(page, 'scroll', { viewport: { width: 834, height: 1112 }, series: true });
  await page.goto('/explore');
  await expect(page.getByRole('complementary', { name: 'This thread' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('complementary', { name: 'This thread' })).toHaveCount(0);
});
