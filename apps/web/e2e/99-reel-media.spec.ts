/** Labelled test-media journey. Run only with KS_WEB_JOURNEY_MODE=reel on a disposable DB. */
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from './support/fixtures.ts';

test('phone Reel uses the protected MP4 route and releases playback on exit', async ({ page, apiFetch }) => {
  test.skip(process.env.KS_WEB_JOURNEY_MODE !== 'reel', 'requires labelled Reel test media');
  const reelFeed = await apiFetch('/v1/feed?kinds=Reel&webArtifact=v1');
  expect(reelFeed.status).toBe(200);
  const feed = await reelFeed.json() as { items: Array<{ mediaUrl?: string; simulated?: boolean }> };
  expect(feed.items).toHaveLength(1);
  const mediaUrl = feed.items[0]?.mediaUrl;
  expect(mediaUrl).toMatch(/^\/v1\/media\/[a-f0-9]{64}$/);
  expect(feed.items[0]?.simulated).toBe(true);
  expect('sourceTitle' in feed.items[0]!).toBe(false);
  expect('sourceUrl' in feed.items[0]!).toBe(false);

  const partial = await apiFetch(mediaUrl!, { headers: { Range: 'bytes=0-31' } });
  expect(partial.status).toBe(206);
  expect(partial.headers.get('content-range')).toMatch(/^bytes 0-31\/\d+$/);
  expect((await partial.arrayBuffer()).byteLength).toBe(32);

  await page.setViewportSize({ width: 390, height: 844 });
  const browserMedia: string[] = [];
  page.on('request', request => {
    if (request.url().includes('/v1/media/')) browserMedia.push(request.url());
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Enter Scroll' }).click();
  const currentKind = () => page.evaluate(() => JSON.parse(localStorage.getItem('ks_web_v1:session') ?? '{}').item?.kind as string | undefined);
  await expect.poll(currentKind).toBeTruthy();
  const screenshots = resolve(process.cwd(), '../../docs/journeys/evidence/web-171/reel');
  await mkdir(screenshots, { recursive: true });
  for (let step = 0; step < 5 && await currentKind() !== 'Reel'; step++) {
    const before = await page.evaluate(() => JSON.parse(localStorage.getItem('ks_web_v1:session') ?? '{}').item?.assetId as string | undefined);
    const next = page.getByRole('button', { name: 'Next discovery' });
    await expect(next).toBeVisible();
    await next.click();
    await expect.poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem('ks_web_v1:session') ?? '{}').item?.assetId as string | undefined)).not.toBe(before);
  }
  const player = page.getByRole('main', { name: 'Reel' });
  await expect(player).toBeVisible();
  await expect(player.getByText('Simulated media')).toBeVisible();
  const video = player.locator('video');
  await expect(video).toHaveCount(1);
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThan(0);
  await expect.poll(() => browserMedia.length).toBeGreaterThan(0);
  expect(browserMedia.every(url => new URL(url).pathname === mediaUrl)).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem('token') ?? sessionStorage.getItem('token'))).toBeNull();

  await player.getByRole('button', { name: /Play video|Pause video/ }).click();
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(0);
  // Owner-supplied local media can contain private frames. Keep those captures out of tracked
  // evidence while retaining the ordinary synthetic-fixture screenshot path.
  if (process.env.KS_WEB_PRIVATE_MEDIA !== '1') {
    await page.screenshot({ path: resolve(screenshots, `reel-390x844-${test.info().project.name}.png`) });
  }

  await player.getByRole('button', { name: /Universe/ }).click();
  await expect(page.getByRole('main', { name: 'Reel' })).toHaveCount(0);
  await expect(page.locator('video')).toHaveCount(0);
});

test('a cancelled Scroll preview does not move, while a committed boundary swipe advances', async ({ page }) => {
  test.skip(process.env.KS_WEB_JOURNEY_MODE !== 'reel', 'requires labelled Reel test media');
  await page.setViewportSize({ width: 390, height: 844 });
  const exposures: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/v1/exposures')) exposures.push(request.url());
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Enter Scroll' }).click();
  const currentKind = () => page.evaluate(() => JSON.parse(localStorage.getItem('ks_web_v1:session') ?? '{}').item?.kind as string | undefined);
  await expect.poll(currentKind).toBeTruthy();
  for (let step = 0; step < 5 && await currentKind() !== 'Scroll'; step++) {
    const before = await page.evaluate(() => JSON.parse(localStorage.getItem('ks_web_v1:session') ?? '{}').item?.assetId as string | undefined);
    await page.getByRole('button', { name: 'Next discovery' }).click();
    await expect.poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem('ks_web_v1:session') ?? '{}').item?.assetId as string | undefined)).not.toBe(before);
  }
  await expect(page.getByRole('article')).toBeVisible();
  const contextButton = page.getByRole('button', { name: 'Open context panel' });
  await expect(contextButton).toBeVisible();
  await contextButton.click();
  await expect(page.getByRole('complementary', { name: 'Scroll context' })).toBeVisible();
  await page.getByRole('button', { name: 'Close the context panel' }).click();
  const screenshots = resolve(process.cwd(), '../../docs/journeys/evidence/web-171/reel');
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: resolve(screenshots, `scroll-390x844-${test.info().project.name}.png`) });
  await page.waitForTimeout(700);
  const exposureCount = exposures.length;
  expect(exposureCount).toBeGreaterThanOrEqual(1);
  const asset = () => page.evaluate(() => JSON.parse(localStorage.getItem('ks_web_v1:session') ?? '{}').item?.assetId as string | undefined);
  const first = await asset();
  await page.locator('.scroll-layout').evaluate(element => { element.scrollTop = element.scrollHeight; });
  const pointer = async (startY: number, endY: number) => {
    await page.evaluate(({ from, to }) => {
      const target = document.querySelector('.reading-column');
      if (!target) throw new Error('Scroll article is missing');
      const send = (type: string, y: number) => target.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true,
        clientX: 180, clientY: y, button: 0,
      }));
      send('pointerdown', from);
      send('pointermove', to);
      send('pointerup', to);
    }, { from: startY, to: endY });
  };
  await pointer(600, 570);
  await page.waitForTimeout(700);
  expect(await asset()).toBe(first);
  expect(exposures).toHaveLength(exposureCount);

  await pointer(600, 440);
  await expect.poll(asset).not.toBe(first);
  await expect.poll(() => exposures.length).toBe(exposureCount + 1);
});
