import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { encounterFixture } from './encounter-fixture';

/**
 * D01 and V01 in the production export over labelled HTTP fixtures: the desktop Reel as a card with
 * its controls around it and the thread beside it, the thread beside a Scroll on a tablet, and a
 * phone with neither. No decoded playback is claimed.
 */

const playableVideo = readFileSync(join(__dirname, 'fixtures', 'blue-60s.webm'));

/** Tab from the top of the page until the Reel stage has focus, as a keyboard user gets there. */
async function tabToStage(page: Page) {
  for (let index = 0; index < 30; index += 1) {
    await page.keyboard.press('Tab');
    if (await page.getByTestId('reel-navigation-stage').evaluate((node) => node === document.activeElement)) return;
  }
  throw new Error('Tab never reached the Reel stage');
}

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

  // Next subject is the same vertical move as a swipe.
  await page.getByRole('button', { name: 'Next subject' }).click();
  await expect.poll(() => intents(commands)).toEqual([{ mode: 'vertical', direction: 'next', format: 'reel' }]);
  await expect(page.getByTestId('encounter-reel-caption')).toContainText('CI encounter fixture 2');
});

test('keys keep working after each move: focus follows the new stage', async ({ page }) => {
  const { commands } = await encounterFixture(page, 'reel', { viewport: { width: 1440, height: 900 }, series: true });
  await page.route('**/media/gesture-fixture', (route) => route.fulfill({ status: 404, body: 'fixture only' }));
  await page.goto('/explore');
  const caption = page.getByTestId('encounter-reel-caption');
  await expect(caption).toContainText('CI encounter fixture 1');
  // Focus is put on the stage once, as Tab does; every later key goes to wherever focus is.
  await tabToStage(page);
  await page.keyboard.press('ArrowDown');
  await expect(caption).toContainText('CI encounter fixture 2');
  await page.keyboard.press('ArrowDown');
  await expect(caption).toContainText('CI encounter fixture 3');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => intents(commands).at(-1)).toMatchObject({ mode: 'series', direction: 'next' });
  await expect.poll(() => intents(commands).length).toBe(3);
  // Alt+Arrow is the browser's own Back and Forward: the stage ignores it.
  await expect(page.getByTestId('reel-navigation-stage')).toBeFocused();
  await page.keyboard.press('Alt+ArrowDown');
  await page.keyboard.press('Control+ArrowDown');
  await page.keyboard.press('Meta+ArrowDown');
  await page.waitForTimeout(300);
  expect(intents(commands)).toHaveLength(3);
});

test('crossing 1024 px keeps the playing Reel: no second exposure, the same video still playing', async ({ page }) => {
  const { commands } = await encounterFixture(page, 'reel', { viewport: { width: 1440, height: 900 }, series: true });
  await page.route('**/media/gesture-fixture', (route) =>
    route.fulfill({ status: 200, contentType: 'video/webm', body: playableVideo }),
  );
  await page.goto('/explore');
  await expect(page.getByTestId('explore-desktop-frame')).toBeVisible();
  const video = await page.locator('video').elementHandle();
  if (!video) throw new Error('The player mounts its video');
  await page.getByRole('button', { name: 'Play' }).click();
  const playing = () => page.locator('video').evaluate((node) => !(node as HTMLVideoElement).paused);
  await expect.poll(playing).toBe(true);
  const opens = () => commands.filter((call) => call.path === '/v1/experience/open').length;
  const activations = () => commands.filter((call) => call.path === '/v1/experience/activate').length;
  expect([opens(), activations()]).toEqual([1, 1]);
  const time = () => page.locator('video').evaluate((node) => (node as HTMLVideoElement).currentTime);
  for (const size of [
    { width: 900, height: 900 },
    { width: 1440, height: 900 },
    { width: 1023, height: 700 },
    { width: 1280, height: 800 },
  ]) {
    const before = await time();
    await page.setViewportSize(size);
    await expect(page.getByTestId('encounter-reel-caption')).toBeVisible();
    expect(await page.locator('video').evaluate((node, original) => node === original, video)).toBe(true);
    await expect.poll(time, { message: `still advancing at ${String(size.width)} px` }).toBeGreaterThan(before);
    expect(await playing()).toBe(true);
    expect([opens(), activations()]).toEqual([1, 1]);
  }
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
