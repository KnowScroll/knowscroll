import { expect, test, type Page } from '@playwright/test';

/**
 * The renderer gate for the space views (v3 U-0, D-100), over the gallery export. It proves, in a
 * real browser with a real WebGL 2 context: the scene draws, the 30 fps cap holds, the loop stops
 * off screen and in a hidden tab, reduced motion draws one frame and stops, and the plain lists
 * replace the scene when WebGL is missing or lost. The numbers are printed so the PR can quote them.
 */

interface Stats {
  readonly frames: number;
  readonly meanIntervalMs: number | null;
  readonly minIntervalMs: number | null;
  readonly meanDrawMs: number | null;
  readonly lastProbe: { litPixels: number; sampledPixels: number; signature: number } | null;
  readonly failure: string | null;
}

interface Recorder {
  stats(): Stats;
  reset(): void;
}
declare global {
  interface Window {
    __ksSpace?: Recorder;
  }
}

const stats = (page: Page): Promise<Stats> => page.evaluate(() => window.__ksSpace!.stats());

async function openScene(page: Page, query = ''): Promise<void> {
  await page.goto(`/gallery-space${query}`);
  await expect(page.getByTestId('ks-space-gallery')).toBeVisible();
  await page.waitForFunction(() => (window.__ksSpace?.stats().frames ?? 0) >= 3, undefined, { timeout: 30_000 });
}

test('draws the scene and holds the 30 fps cap', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openScene(page);
  await page.evaluate(() => window.__ksSpace!.reset());
  await page.waitForTimeout(4000);
  const measured = await stats(page);

  // The canvas is drawing: lit pixels were read back, and the picture moved between two probes.
  expect(measured.failure).toBeNull();
  expect(measured.lastProbe!.litPixels).toBeGreaterThan(20);
  const firstSignature = measured.lastProbe!.signature;
  await page.waitForFunction((before) => window.__ksSpace!.stats().lastProbe?.signature !== before, firstSignature, {
    timeout: 10_000,
  });

  // The cap: frames are at least ~33 ms apart (one vsync of slack), so never more than ~30 per second.
  expect(measured.meanIntervalMs).not.toBeNull();
  expect(measured.meanIntervalMs!).toBeGreaterThanOrEqual(30);
  expect(measured.minIntervalMs!).toBeGreaterThanOrEqual(31);

  const line = `space gate (web, 390x844): mean interval ${measured.meanIntervalMs!.toFixed(1)} ms, min ${measured.minIntervalMs!.toFixed(1)} ms, mean draw ${measured.meanDrawMs!.toFixed(1)} ms, lit ${measured.lastProbe!.litPixels}/${measured.lastProbe!.sampledPixels}`;
  // eslint-disable-next-line no-console -- the gate numbers go in the PR description
  console.log(line);
  await testInfo.attach('space-gate-numbers', { body: line, contentType: 'text/plain' });
  await page.screenshot({ path: testInfo.outputPath('space-390x844.png') });
});

test('draws the Universe composition (systems, a station, the ship) and holds the cap', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openScene(page, '?scene=universe');
  await page.evaluate(() => window.__ksSpace!.reset());
  await page.waitForTimeout(4000);
  const measured = await stats(page);
  expect(measured.failure).toBeNull();
  expect(measured.lastProbe!.litPixels).toBeGreaterThan(20);
  expect(measured.meanIntervalMs!).toBeGreaterThanOrEqual(30);
  expect(measured.minIntervalMs!).toBeGreaterThanOrEqual(31);
  // The labels of the sample systems are views over the canvas, reachable by name.
  await expect(page.getByRole('button', { name: 'Sample system one, a system', exact: true })).toBeVisible();
  const line = `universe scene (web, 390x844): mean interval ${measured.meanIntervalMs!.toFixed(1)} ms, min ${measured.minIntervalMs!.toFixed(1)} ms, mean draw ${measured.meanDrawMs!.toFixed(1)} ms over ${measured.frames} frames`;
  // eslint-disable-next-line no-console -- the numbers go in the PR description
  console.log(line);
  await testInfo.attach('universe-scene-numbers', { body: line, contentType: 'text/plain' });
  await page.screenshot({ path: testInfo.outputPath('universe-scene-390x844.png') });
});

test('draws at a desktop size too', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openScene(page);
  await page.waitForTimeout(1500);
  const measured = await stats(page);
  expect(measured.failure).toBeNull();
  expect(measured.lastProbe!.litPixels).toBeGreaterThan(20);
  await page.screenshot({ path: testInfo.outputPath('space-1440x900.png') });
});

test('pauses when the scene is scrolled off screen and resumes when it returns', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openScene(page);

  await page.getByText('End of the page.').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  const paused = (await stats(page)).frames;
  await page.waitForTimeout(800);
  expect((await stats(page)).frames).toBe(paused);

  await page.getByTestId('ks-space-stage').scrollIntoViewIfNeeded();
  await page.waitForFunction((before) => window.__ksSpace!.stats().frames > before + 3, paused, { timeout: 10_000 });
});

test('pauses when the tab is hidden and resumes when it is shown', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openScene(page);
  const setVisibility = (state: 'hidden' | 'visible') =>
    page.evaluate((next) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => next });
      document.dispatchEvent(new Event('visibilitychange'));
    }, state);

  await setVisibility('hidden');
  await page.waitForTimeout(500);
  const paused = (await stats(page)).frames;
  await page.waitForTimeout(800);
  expect((await stats(page)).frames).toBe(paused);

  await setVisibility('visible');
  await page.waitForFunction((before) => window.__ksSpace!.stats().frames > before + 3, paused, { timeout: 10_000 });
});

test('with reduced motion it draws one frame and starts no loop', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/gallery-space');
  await expect(page.getByTestId('ks-space-gallery')).toBeVisible();
  await page.waitForFunction(() => (window.__ksSpace?.stats().frames ?? 0) >= 1, undefined, { timeout: 30_000 });
  await page.waitForTimeout(2000);
  const measured = await stats(page);
  expect(measured.frames).toBe(1);
  expect(measured.lastProbe!.litPixels).toBeGreaterThan(20);
  await expect(page.getByTestId('ks-space-readout')).toContainText('reduced motion');
  await testInfo.attach('space-gate-numbers', {
    body: `space gate (web, reduced motion): ${measured.frames} frame after 2 s`,
    contentType: 'text/plain',
  });
});

test.describe('without WebGL', () => {
  test('the plain lists replace the scene when WebGL cannot be created', async ({ page }) => {
    await page.addInitScript(() => {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- kept to call it back with the right `this`
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
        if (kind === 'webgl' || kind === 'webgl2' || kind === 'experimental-webgl') return null;
        return (original as (...args: unknown[]) => unknown).call(this, kind, ...rest);
      } as typeof original;
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/gallery-space');
    const lists = page.getByTestId('ks-space-simple');
    await expect(lists).toBeVisible({ timeout: 30_000 });
    await expect(lists.getByRole('heading', { name: 'Sample system' })).toBeVisible();
    await expect(lists.getByRole('button', { name: /First sample planet/ })).toBeVisible();
    await expect(page.getByTestId('ks-space-readout')).toContainText('Simple lists shown');
  });

  test('the plain lists replace the scene when the WebGL context is lost', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openScene(page);
    await page.evaluate(() => {
      const canvas = document.querySelector('canvas')!;
      const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl'))!;
      gl.getExtension('WEBGL_lose_context')!.loseContext();
    });
    await expect(page.getByTestId('ks-space-simple')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('canvas')).toHaveCount(0);
    await expect(page.getByTestId('ks-space-readout')).toContainText('context-lost');
  });
});
