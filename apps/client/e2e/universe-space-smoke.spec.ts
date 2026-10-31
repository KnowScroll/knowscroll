import { expect, test, type Page } from '@playwright/test';
import { COLLECTION_READS, fixtureAccount, fixtureId, sceneFixture } from '../features/universe/universe.fixture';
import { emptyInbox, isInboxPath } from './empty-inbox';
import { tapOrbitingTarget } from './orbiting-target';

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
  ...COLLECTION_READS,
]);

interface Request {
  readonly method: string;
  readonly path: string;
}

interface Options {
  readonly size?: { width: number; height: number };
  /** Dust cues the emerging read answers with, and whether one room station sits beside the first system. */
  readonly dust?: number;
  readonly station?: boolean;
  /** The test walks the map, not its animations (universe-animations-smoke.spec.ts has those). */
  readonly calm?: boolean;
}

/** A room whose topic is the fixture's first system (authored for CI, never product data). */
const station = {
  room: {
    roomId: '0199d000-0000-7000-8000-0000000000a1',
    name: 'CI room',
    description: 'A room about the first system.',
    topic: { kind: 'system', id: 'ci-topic', label: 'CI topic' },
    joinRule: 'open',
    status: 'open',
    // The room's face (D-170): its emblem is drawn on the station over the 3D map (the Simple views draw none).
    identity: {
      kit: {
        version: 'station-kit.v1',
        palette: { ground: 'midnight', accent: 'sun', ink: 'cream' },
        emblem: { frame: 'circle', glyph: 'ringed-planet' },
        motif: 'constellation',
        motion: 'twinkle',
        cast: { explainer: 'star', skeptic: 'atom' },
      },
    },
  },
  standing: 'none',
  placement: { systemId: fixtureId(10) },
} as const;

async function openUniverse(page: Page, requests: Request[], options: Options = {}): Promise<void> {
  const size = options.size ?? { width: 390, height: 844 };
  const world = sceneFixture(5, options.dust ?? 0);
  if (options.station === true) world.stations.push(station);
  await page.setViewportSize(size);
  if (options.calm === true) await page.emulateMedia({ reducedMotion: 'reduce' });
  // Count the frames the renderer draws: three.js clears the canvas once per frame. A frame is stamped
  // with the time the browser gave its animation-frame callback (the stamp the 30 fps cap is decided on),
  // not the time `clear` ran: that moves with the runner's stalls, and two frames could then look 14 ms apart.
  await page.addInitScript(() => {
    const frames: number[] = [];
    (window as unknown as { __ksFrames: number[] }).__ksFrames = frames;
    let frameStamp: number | null = null;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called back with the right `this` below
    const request = window.requestAnimationFrame;
    window.requestAnimationFrame = (callback) =>
      request.call(window, (stamp) => {
        frameStamp = stamp;
        try {
          callback(stamp);
        } finally {
          frameStamp = null;
        }
      });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called back with the right `this` below
    const clear = WebGL2RenderingContext.prototype.clear;
    WebGL2RenderingContext.prototype.clear = function (this: WebGL2RenderingContext, mask: number): void {
      frames.push(frameStamp ?? performance.now());
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
    if (path === '/v1/rooms/stations') return route.fulfill({ json: world.reply(path, body) });
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
  await expect(page.getByTestId('universe-simple')).toHaveCount(0);
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

test('stations, dust, Lately, search, the ship’s chip and the Far card all work over the 3D map and write nothing', async ({
  page,
}) => {
  const requests: Request[] = [];
  await openUniverse(page, requests, { dust: 1, station: true, calm: true });
  const system = page.getByRole('button', { name: 'CI system 0, a system', exact: true });
  await expect(system).toBeVisible({ timeout: 60_000 });

  // A room station sits beside its system, and dust is a cue that explains itself and goes nowhere.
  await expect(page.getByRole('button', { name: 'CI room, a room station', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Recent reading is gathering here', exact: true }).click();
  await expect(page.getByText('Recent explorations are gathering here.')).toBeVisible();
  await page.getByRole('button', { name: 'Close note', exact: true }).click();
  await expect(page.getByText('Recent explorations are gathering here.')).toHaveCount(0);

  // Lately is a lens: it changes how places draw and which is listed first, and it is remembered on the device.
  const lately = page.getByRole('button', { name: 'Lately', exact: true });
  await lately.click();
  await expect(lately).toHaveAttribute('aria-pressed', 'true');
  await lately.click();
  await expect(lately).toHaveAttribute('aria-pressed', 'false');

  // Search flies to a planet; stepping back up leaves the ship parked there, offered as "Return to <planet>".
  await page.getByRole('button', { name: 'Search your universe', exact: true }).click();
  await page.getByLabel('Search your universe').fill('planet 3');
  await page.getByRole('button', { name: /CI planet 3, planet/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'CI planet 3', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to CI system 0', exact: true }).click();
  await expect(page.getByRole('button', { name: 'CI room, a room station', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to Universe', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Return to CI planet 3', exact: true })).toBeVisible();

  // Drawn back far enough the map reads as Far: a first tap picks the system and shows its card.
  await page.getByTestId('universe-map').focus();
  for (let step = 0; step < 6; step++) await page.keyboard.press('-');
  await system.click();
  await expect(page.getByTestId('universe-system-card')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'CI system 0', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open system', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'CI system 0', exact: true })).toBeVisible();

  // J3 again, over everything the map offers: only reads left the page.
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
  // The cap: the loop draws a frame only when its stamp is 32 ms or more after the last drawn one (33 ms
  // less 1 ms of vsync jitter), and a stall only lengthens a gap. So no gap is shorter, and the mean is
  // at least the cap; a loop that drew on every 16 ms frame would fail both.
  expect(mean).toBeGreaterThanOrEqual(32);
  expect(Math.min(...gaps)).toBeGreaterThanOrEqual(32);
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
  await openUniverse(page, requests, { size: { width: 1440, height: 900 } });
  await expect(page.getByRole('button', { name: 'CI system 0, a system', exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await expect.poll(() => sunPixels(page), { timeout: 30_000 }).toBeGreaterThan(40);
  await expect(page.getByRole('complementary', { name: 'Outline' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('universe-overview-1440x900.png') });
});

test('search, the orbit dial and the Simple view work over the real map; search makes no request, and nothing is written', async ({
  page,
}) => {
  const requests: Request[] = [];
  await openUniverse(page, requests, { station: true });
  const system = page.getByRole('button', { name: 'CI system 0, a system', exact: true });
  await expect(system).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'CI room, a room station', exact: true })).toBeVisible();

  // Search on the device: typing and choosing make no request at all.
  const everything: string[] = [];
  page.on('request', (request) => everything.push(request.url()));
  await page.getByRole('button', { name: 'Search your universe', exact: true }).click();
  await expect(page.getByText('Find any place you’ve been')).toBeVisible();
  await page.getByLabel('Search your universe').fill('ci');
  await expect(page.getByRole('button', { name: 'CI room, room, in CI system 0', exact: true })).toBeVisible();
  await page.getByLabel('Search your universe').fill('planet 3');
  await page.getByLabel('Search your universe').press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'CI planet 3', exact: true })).toBeVisible();
  expect(everything).toEqual([]);

  // Back restores where the person was looking; Escape then closes the card and steps up a level.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { level: 1, name: 'CI system 0', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(system).toBeVisible();

  // The orbit dial: the wheel of systems, the filters, the dial of planets, and Land.
  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await expect(page.getByTestId('universe-dial')).toBeVisible();
  await expect(page.getByTestId('dial-planet-facts')).toBeVisible();
  await page.getByTestId('dial-system-pill').click();
  await expect(page.getByTestId('dial-system-facts')).toContainText('System 1 of 1');
  await page.getByRole('button', { name: 'With rooms, 1', exact: true }).click();
  await expect(page.getByTestId('dial-system-facts')).toContainText('1 room');
  await page.getByRole('button', { name: 'CI system 0, a system, 2 planets', exact: true }).click();
  await page.getByRole('button', { name: 'Land on CI planet 2', exact: true }).click();
  await expect(page.getByTestId('universe-level')).toHaveText('PLANET');
  await page.getByRole('button', { name: 'Back to CI system 0', exact: true }).click();
  await page.getByRole('button', { name: 'Back to Universe', exact: true }).click();

  // The Simple view: two plain lists, remembered, and the switch turns it off again.
  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await page.getByRole('button', { name: 'Simple view', exact: true }).click();
  await expect(page.getByTestId('universe-simple')).toBeVisible();
  await expect(page.getByText('Plain lists, for slow devices')).toBeVisible();
  await page.getByRole('button', { name: 'CI planet 2, a planet in CI system 0', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'CI planet 2', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to Your universe', exact: true }).click();
  await page.getByRole('switch', { name: 'Simple view', exact: true }).click();
  await expect(page.getByTestId('universe-simple')).toHaveCount(0);

  // J3 over search, the dial and the Simple view: only the Universe's own reads left the page.
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every(({ method, path }) => method === 'POST' && READS.has(path))).toBe(true);
  expect(
    requests.some(({ path }) => /region\/open|activate|observations|formation\/(claim|acknowledge)/.test(path)),
  ).toBe(false);
});

test('draws the desktop panel, docks a picked planet’s card, and the Simple drawing switch turns the map into lists', async ({
  page,
}, testInfo) => {
  const requests: Request[] = [];
  await openUniverse(page, requests, { size: { width: 1440, height: 900 }, station: true });
  await expect(page.getByRole('button', { name: 'CI system 0, a system', exact: true }).first()).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole('button', { name: 'CI system 0, a system', exact: true }).first().click();
  await tapOrbitingTarget(page.getByRole('button', { name: 'CI planet 2, a planet', exact: true }).first());
  await expect(page.getByTestId('universe-planet-card')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Zoom in', exact: true })).toBeVisible();
  await expect(page.getByText('Back up a level')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('universe-d02-1440x900.png') });
  await page.getByRole('button', { name: 'Land on CI planet 2', exact: true }).click();
  await expect(page.getByTestId('universe-level')).toHaveText('PLANET');
  await page.getByTestId('universe-map').focus();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { level: 1, name: 'CI system 0', exact: true })).toBeVisible();
  await page.getByRole('switch', { name: 'Simple drawing', exact: true }).click();
  await expect(page.getByTestId('universe-simple')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('universe-simple-1440x900.png') });
  expect(requests.every(({ method, path }) => method === 'POST' && READS.has(path))).toBe(true);
});
