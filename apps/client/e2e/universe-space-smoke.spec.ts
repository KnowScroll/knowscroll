import { expect, test, type Page } from '@playwright/test';
import { fixtureAccount, sceneFixture } from '../features/universe/universe.fixture';
import { emptyInbox, isInboxPath } from './empty-inbox';

/**
 * The Universe tab's space views (v3 U-2, D-106) in a real browser with a real WebGL 2 context, over
 * authored HTTP fixtures: the map is drawn by three.js, every place is still a named button over it,
 * the camera flies in and out, and browsing the map (pan, zoom, Lately, fly, search) sends no write.
 * The gallery spec proves the renderer; this one proves the tab that uses it.
 */

const READS = new Set([
  '/v1/universe/geography/read',
  '/v1/universe/geography/deltas/read',
  '/v1/universe/scenes/manifest/read',
  '/v1/universe/scenes/chunks/read',
  '/v1/universe/emerging/read',
  '/v1/experience/region/preview',
  '/v1/universe/formation/read',
  '/v1/rooms/stations',
]);

interface Request {
  readonly method: string;
  readonly path: string;
}

async function openUniverse(page: Page, requests: Request[], size = { width: 390, height: 844 }): Promise<void> {
  const world = sceneFixture();
  await page.setViewportSize(size);
  // Count the frames the renderer draws: three.js clears the canvas once per frame.
  await page.addInitScript(() => {
    const frames: number[] = [];
    (window as unknown as { __ksFrames: number[] }).__ksFrames = frames;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called back with the right `this` below
    const clear = WebGL2RenderingContext.prototype.clear;
    WebGL2RenderingContext.prototype.clear = function (this: WebGL2RenderingContext, mask: number): void {
      frames.push(performance.now());
      clear.call(this, mask);
    };
  });
  await page.route('**/auth/session', (route) =>
    route.fulfill({ json: { account: fixtureAccount, client: 'web', expiresAt: '2099-10-21T00:00:00.000Z' } }),
  );
  await page.route('**/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    if (path === '/v1/privacy/recording/read')
      return route.fulfill({
        json: {
          ...body,
          scope: { accountId: fixtureAccount.accountId, privacyEpoch: 1 },
          revision: 0,
          policy: { on: true, generation: 1 },
        },
      });
    // The other tabs' inbox reads are not the map's: only the Universe's own reads are counted.
    if (!isInboxPath(path) || path === '/v1/rooms/stations') requests.push({ method: route.request().method(), path });
    if (isInboxPath(path)) return route.fulfill({ json: emptyInbox(path, body, fixtureAccount.accountId) });
    if (path.endsWith('/formation/read'))
      return route.fulfill({
        json: {
          ...body,
          scope: { universeId: fixtureAccount.universeId, privacyEpoch: 1, personalWatermark: 40 },
          recordedAt: '2026-10-22T00:00:00.000Z',
          currentGeography: { revision: 3, structureRevision: 3, activityRevision: 0 },
          sceneRevision: 7,
          status: 'unavailable',
          reason: 'temporarily_unavailable',
        },
      });
    return route.fulfill({ json: world.reply(path, body) });
  });
  await page.goto('/universe');
}

/** The share of the screenshot's pixels that are warm and bright: the orange suns and their glow. */
async function sunPixels(page: Page): Promise<number> {
  const png = (await page.screenshot()).toString('base64');
  const reader = await page.context().newPage();
  try {
    await reader.goto('about:blank');
    return await reader.evaluate(async (data) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let warm = 0;
      for (let at = 0; at < pixels.length; at += 4)
        if (pixels[at]! > 200 && pixels[at + 1]! > 110 && pixels[at + 2]! < 140) warm += 1;
      return warm;
    }, png);
  } finally {
    await reader.close();
  }
}

const frames = (page: Page): Promise<number[]> =>
  page.evaluate(() => [...(window as unknown as { __ksFrames: number[] }).__ksFrames]);

test('draws the systems in 3D, flies into one and back, and browsing sends no write', async ({ page }, testInfo) => {
  const requests: Request[] = [];
  await openUniverse(page, requests);
  const system = page.getByRole('button', { name: 'CI system 0, a system', exact: true });
  await expect(system).toBeVisible({ timeout: 60_000 });
  // The picture is the 3D scene, not the plain lists: warm sun pixels are on screen.
  await expect(page.getByTestId('ks-space-simple')).toHaveCount(0);
  await expect.poll(() => sunPixels(page), { timeout: 30_000 }).toBeGreaterThan(40);
  await page.screenshot({ path: testInfo.outputPath('universe-overview-390x844.png') });

  // Pan, zoom and the Lately lens by keyboard and by touch target, and a fly in and back out.
  await page.getByTestId('universe-map').focus();
  for (const key of ['ArrowRight', 'ArrowDown', '+', '-', 'Home']) await page.keyboard.press(key);
  await page.getByRole('button', { name: 'Lately', exact: true }).click();
  await page.getByRole('button', { name: 'Lately', exact: true }).click();
  await system.click();
  await expect(page.getByRole('heading', { level: 1, name: 'CI system 0', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'CI planet 2, a planet', exact: true })).toBeVisible();
  await page.waitForTimeout(3000);
  await expect.poll(() => sunPixels(page), { timeout: 30_000 }).toBeGreaterThan(40);
  await page.screenshot({ path: testInfo.outputPath('universe-system-390x844.png') });
  await page.getByRole('button', { name: 'Back to Universe', exact: true }).click();
  await expect(system).toBeVisible();

  // J3 for the 3D renderer: nothing but reads left the page, and no read said what was looked at.
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every(({ method, path }) => method === 'POST' && READS.has(path))).toBe(true);
  expect(
    requests.some(({ path }) => /region\/open|activate|observations|formation\/(claim|acknowledge)/.test(path)),
  ).toBe(false);
});

test('holds the 30 fps cap on the real tab, and stops drawing when the tab is hidden', async ({ page }, testInfo) => {
  const requests: Request[] = [];
  await openUniverse(page, requests);
  await expect(page.getByRole('button', { name: 'CI system 0, a system', exact: true })).toBeVisible({
    timeout: 60_000,
  });
  const before = (await frames(page)).length;
  await page.waitForTimeout(4000);
  const drawn = (await frames(page)).slice(before);
  expect(drawn.length).toBeGreaterThan(10);
  const gaps = drawn.slice(1).map((at, index) => at - drawn[index]!);
  const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
  // The cap: ~33 ms between frames on average. Single gaps are read at draw time, not at the frame stamp,
  // so they jitter a few ms either way; one under 25 ms would mean the loop runs above 40 per second.
  expect(mean).toBeGreaterThanOrEqual(30);
  expect(Math.min(...gaps)).toBeGreaterThanOrEqual(25);
  const line = `universe tab (web, 390x844): ${drawn.length} frames in 4 s, mean interval ${mean.toFixed(1)} ms, min ${Math.min(...gaps).toFixed(1)} ms`;
  // eslint-disable-next-line no-console -- the numbers go in the PR description
  console.log(line);
  await testInfo.attach('universe-tab-frame-numbers', { body: line, contentType: 'text/plain' });

  // A hidden tab draws nothing.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(500);
  const stopped = (await frames(page)).length;
  await page.waitForTimeout(1500);
  expect((await frames(page)).length).toBe(stopped);
});

test('with reduced motion it draws a still map and flies by jumping', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const requests: Request[] = [];
  await openUniverse(page, requests);
  const system = page.getByRole('button', { name: 'CI system 0, a system', exact: true });
  await expect(system).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  const still = (await frames(page)).length;
  expect(still).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(1500);
  expect((await frames(page)).length).toBe(still);
  // Entering a system redraws the one still frame at once: no fly, no loop.
  await system.click();
  await expect(page.getByRole('button', { name: 'CI planet 2, a planet', exact: true })).toBeVisible();
  const entered = (await frames(page)).length;
  expect(entered).toBeGreaterThan(still);
  await page.waitForTimeout(1500);
  expect((await frames(page)).length).toBe(entered);
});

test('draws at a desktop size with the outline beside it', async ({ page }, testInfo) => {
  const requests: Request[] = [];
  await openUniverse(page, requests, { width: 1440, height: 900 });
  await expect(page.getByRole('button', { name: 'CI system 0, a system', exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await expect.poll(() => sunPixels(page), { timeout: 30_000 }).toBeGreaterThan(40);
  await expect(page.getByRole('complementary', { name: 'Outline' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('universe-overview-1440x900.png') });
});
