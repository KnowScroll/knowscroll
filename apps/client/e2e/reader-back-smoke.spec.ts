import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { encounterFixture } from './encounter-fixture';

const playableVideo = readFileSync(join(__dirname, 'fixtures', 'blue-60s.webm'));

/**
 * Back step by step (v3 journey J5, #609): a detour to Account and settings from the ••• sheet is a client-side move, so
 * one browser Back returns to Explore without the app restarting, and a Reel that was paused before a sheet is still paused
 * after the sheet closes, however it closes and however many times it has opened. Production export over labelled HTTP
 * fixtures (a playable CI video, not product media). The fixture video cannot be seeked, so these checks read the app's
 * state (no new document, paused or not) and not the second a video is at.
 */
const phone = { width: 390, height: 844 };
const desktop = { width: 1440, height: 900 };

const paused = (page: Page) => page.locator('video').evaluate((node) => (node as HTMLVideoElement).paused);

/** Opens Explore on a Reel, moves on once so there is somewhere to go Back to, then plays it a moment and pauses it. */
async function pausedReel(page: Page, viewport: { width: number; height: number }) {
  const served = await encounterFixture(page, 'reel', { viewport, series: true });
  await page.route('**/media/gesture-fixture', (route) =>
    route.fulfill({ status: 200, contentType: 'video/webm', body: playableVideo }),
  );
  const documents: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'document') documents.push(new URL(request.url()).pathname);
  });
  await page.goto('/explore');
  await expect(page.getByTestId('reel-player')).toBeVisible();
  const hint = page.getByRole('button', { name: 'Got it' });
  if (await hint.isVisible()) await hint.click();
  await page.getByRole('button', { name: 'More options', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Next subject' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Play' }).click();
  await expect.poll(async () => (await paused(page)) === false).toBe(true);
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect.poll(() => paused(page)).toBe(true);
  return { ...served, documents };
}

for (const viewport of [phone, desktop]) {
  const size = `${String(viewport.width)} × ${String(viewport.height)}`;

  test(`More, Account and settings, then one browser Back returns to Explore without the app restarting, at ${size}`, async ({
    page,
  }) => {
    const reel = await pausedReel(page, viewport);
    const lineage = () => reel.commands.filter((call) => /\/(open|activate|navigate)$/.test(call.path)).length;
    const before = lineage();
    await page.evaluate(() => {
      (window as unknown as { __ksSameDocument?: boolean }).__ksSameDocument = true;
    });
    await page.getByRole('button', { name: 'More options', exact: true }).click();
    await page.getByRole('dialog').getByRole('link', { name: 'Account and settings' }).click();
    await expect(page).toHaveURL(/\/account$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/explore$/);
    await expect(page.getByTestId('reel-player')).toBeVisible();
    // The app never restarted: no second document was fetched and what the page held is still there.
    expect(reel.documents).toEqual(['/explore']);
    expect(await page.evaluate(() => (window as unknown as { __ksSameDocument?: boolean }).__ksSameDocument)).toBe(
      true,
    );
    await expect.poll(() => paused(page)).toBe(true);
    // Back is not a new encounter: nothing was opened, activated or navigated for it.
    expect(lineage()).toBe(before);
  });

  test(`a Reel paused before the Share sheet is still paused when it closes with Esc and then, a second time, with Back, at ${size}`, async ({
    page,
  }) => {
    await pausedReel(page, viewport);
    for (const close of ['Escape', 'Back'] as const) {
      await page.getByRole('button', { name: 'Share', exact: true }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      if (close === 'Back') await page.goBack();
      else await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page).toHaveURL(/\/explore$/);
      // Give a Reel that would play on the time to start.
      await page.waitForTimeout(1500);
      expect(await paused(page), `paused after the sheet closed with ${close}`).toBe(true);
    }
  });
}
