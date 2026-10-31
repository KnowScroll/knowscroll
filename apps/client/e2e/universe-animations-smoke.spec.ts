import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { fixtureAccount, sceneFixture } from '../features/universe/universe.fixture';
import { emptyInbox, isInboxPath } from './empty-inbox';
import { tapOrbitingTarget } from './orbiting-target';

/**
 * The first open and the three steps down (v3 U-6, D-114 to D-116) in a real browser with a real WebGL 2
 * context, over authored HTTP fixtures. What it proves: each animation plays and ends on the screen it joins,
 * taps are ignored while one plays, Back jumps to the end frame, the 30 fps cap and the 1.5 pixel ratio hold
 * while they play, reduced motion and the desktop layout play none, the first open claims the account's one
 * opening exactly once, and axe finds nothing serious in the middle of any of them. Set `KS_SHOT_DIR` to also
 * save screenshots for the design comparison.
 */
const shots = process.env['KS_SHOT_DIR'];

// A runner without a GPU draws these scenes in software, a few frames a second: an animation then takes longer on
// the wall clock (its time value moves by at most 0.1 s a frame, by design), so nothing here waits for a moment of it.
test.describe.configure({ timeout: 300_000 });
// A phone's pixel density is 3: the drawing buffer must still be capped at 1.5 pixels per layout pixel (D-100).
test.use({ deviceScaleFactor: 3 });
const ENDS = { timeout: 120_000 } as const;
/** The whole first open takes longer on the wall clock when frames are slow: its `t` moves by at most 0.1 s a frame. */
const OPENING = { timeout: 240_000 } as const;

const FIRST_OPEN_PATH = '/v1/account/universe/first-open';

interface Options {
  readonly size?: { width: number; height: number };
  /** What the account answers when asked whether it may play the first open. */
  readonly claim?: boolean;
  readonly reducedMotion?: boolean;
  readonly places?: boolean;
}

interface Written {
  readonly claims: number[];
  readonly requests: { method: string; path: string }[];
}

async function openUniverse(page: Page, options: Options = {}): Promise<Written> {
  const size = options.size ?? { width: 390, height: 844 };
  const world = sceneFixture(options.places === false ? 0 : 5, 0, 3);
  const written: Written = { claims: [], requests: [] };
  await page.setViewportSize(size);
  if (options.reducedMotion === true) await page.emulateMedia({ reducedMotion: 'reduce' });
  // Frame stamps are the ones the browser gives the animation-frame callback: the stamp the 30 fps cap is decided on.
  await page.addInitScript(() => {
    const frames: number[] = [];
    const ratios: number[] = [];
    (window as unknown as { __ksFrames: number[]; __ksRatios: number[] }).__ksFrames = frames;
    (window as unknown as { __ksRatios: number[] }).__ksRatios = ratios;
    let frameStamp: number | null = null;
    // The stamp of the last animation-frame callback, for what is watched from outside it (a style the animation moves).
    const windowStamps = window as unknown as { __ksLastStamp: number };
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called back with the right `this` below
    const request = window.requestAnimationFrame;
    window.requestAnimationFrame = (callback) =>
      request.call(window, (stamp) => {
        frameStamp = stamp;
        windowStamps.__ksLastStamp = stamp;
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
      ratios.push(this.drawingBufferWidth / (this.canvas as HTMLCanvasElement).clientWidth);
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
    if (path === FIRST_OPEN_PATH) {
      written.claims.push(Date.now());
      // Only the first request is told it may play: the account has one opening.
      return route.fulfill({ json: { claimed: options.claim === true && written.claims.length === 1 } });
    }
    if (isInboxPath(path)) return route.fulfill({ json: emptyInbox(path, body, fixtureAccount.accountId) });
    written.requests.push({ method: route.request().method(), path });
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
  return written;
}

const frames = (page: Page): Promise<number[]> =>
  page.evaluate(() => [...(window as unknown as { __ksFrames: number[] }).__ksFrames]);
const ratios = (page: Page): Promise<number[]> =>
  page.evaluate(() => [...(window as unknown as { __ksRatios: number[] }).__ksRatios]);

/**
 * The cap, over the frames drawn between two marks: no two are closer than 32 ms (the 30 fps cap with a millisecond of
 * jitter), none is denser than 1.5 pixels per layout pixel, and the densest is that (the page is at density 3, so a
 * loop that ignored the cap would show 3).
 */
async function expectCapped(page: Page, from: number, to?: number): Promise<void> {
  const stamps = (await frames(page)).slice(from, to);
  expect(stamps.length).toBeGreaterThan(8);
  const gaps = stamps.slice(1).map((at, index) => at - stamps[index]!);
  expect(Math.min(...gaps)).toBeGreaterThanOrEqual(32);
  const density = (await ratios(page)).slice(from, to);
  for (const ratio of density) expect(ratio).toBeLessThanOrEqual(1.5 + 1e-6);
  expect(Math.max(...density)).toBeGreaterThan(1.4);
}

/** The frames drawn so far: a mark to measure from. */
const mark = async (page: Page): Promise<number> => (await frames(page)).length;

/**
 * The cap on an animation that is only a moving style (the world opening out has no 3D scene): the stamps of the
 * animation-frame callbacks in which the circle's style changed. Starts watching when called.
 */
async function watchStyle(page: Page, testId: string): Promise<void> {
  await page.evaluate((id) => {
    const seen: number[] = [];
    (window as unknown as { __ksStyle: number[] }).__ksStyle = seen;
    const target = document.querySelector(`[data-testid="${id}"] > div`);
    if (target === null) throw new Error('nothing to watch');
    new MutationObserver(() => {
      const stamp = (window as unknown as { __ksLastStamp: number }).__ksLastStamp;
      if (seen.at(-1) !== stamp) seen.push(stamp);
    }).observe(target, { attributes: true, attributeFilter: ['style'] });
  }, testId);
}
async function expectStyleCapped(page: Page): Promise<void> {
  const stamps = await page.evaluate(() => [...(window as unknown as { __ksStyle: number[] }).__ksStyle]);
  expect(stamps.length).toBeGreaterThan(8);
  const gaps = stamps.slice(1).map((at, index) => at - stamps[index]!);
  expect(Math.min(...gaps)).toBeGreaterThanOrEqual(32);
}

async function expectAccessible(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page }).analyze();
  const serious = result.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  expect(serious.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
}

const system = (page: Page) => page.getByRole('button', { name: 'CI system 0, a system', exact: true });
const planet = (page: Page) => page.getByRole('button', { name: 'CI planet 2, a planet', exact: true });

test.describe('the three steps down at 390 x 844', () => {
  test('a system is entered by ship, a planet by a glide down to its globe, and a world by opening its map', async ({
    page,
  }, testInfo) => {
    const written = await openUniverse(page);
    await expect(system(page)).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(500);
    const before = await mark(page);

    // Entering a system: the ring marks the tap, taps meanwhile do nothing, and it ends on the system screen.
    await tapOrbitingTarget(system(page));
    await expect(page.getByTestId('universe-tap-ring')).toBeAttached();
    await page.waitForTimeout(1500);
    if (shots) await page.screenshot({ path: `${shots}/enter-system-1.5s-390x844.png` });
    await tapOrbitingTarget(planet(page).first()).catch(() => undefined);
    await expect(page.getByRole('heading', { level: 1, name: 'CI system 0', exact: true })).toBeVisible();
    await expectAccessible(page);
    await expect(page.getByTestId('universe-tap-ring')).toHaveCount(0, ENDS);
    await expectCapped(page, before, await mark(page));
    if (shots) await page.screenshot({ path: `${shots}/enter-system-end-390x844.png` });
    await expect(page.getByRole('button', { name: 'Back to Universe', exact: true })).toBeVisible();

    // Entering a planet: the globe is laid over the 3D planet, then it is the planet's own view.
    const planetFrom = await mark(page);
    await tapOrbitingTarget(planet(page));
    await expect(page.getByTestId('universe-globe-layer')).toBeAttached();
    await page.waitForTimeout(1800);
    if (shots) await page.screenshot({ path: `${shots}/enter-planet-1.8s-390x844.png` });
    await expectAccessible(page);
    await expect(page.getByTestId('universe-globe-layer')).toHaveCount(0, ENDS);
    await expectCapped(page, planetFrom, await mark(page));
    await expect(page.getByText('Drag to rotate · tap to land')).toBeVisible();
    if (shots) await page.screenshot({ path: `${shots}/enter-planet-end-390x844.png` });

    // Entering a world: the globe flattens into the map and the live map takes over.
    await page.getByRole('button', { name: 'Land on CI planet 2', exact: true }).click();
    await expect(page.getByTestId('universe-world-layers')).toBeAttached();
    await watchStyle(page, 'universe-world-layers');
    await page.waitForTimeout(1300);
    if (shots) await page.screenshot({ path: `${shots}/enter-world-1.3s-390x844.png` });
    await expectAccessible(page);
    await expect(page.getByTestId('universe-world-layers')).toHaveCount(0, ENDS);
    await expectStyleCapped(page);
    await expect(page.getByRole('button', { name: 'CI region 4, a region', exact: true })).toBeVisible();
    if (shots) await page.screenshot({ path: `${shots}/enter-world-end-390x844.png` });

    // Browsing wrote nothing: only the Universe's own reads left the page.
    expect(written.requests.every(({ method }) => method === 'POST')).toBe(true);
    expect(
      written.requests.some(({ path }) =>
        /region\/open|activate|observations|formation\/(claim|acknowledge)/.test(path),
      ),
    ).toBe(false);
    expect(testInfo.errors).toEqual([]);
  });

  test('Back jumps to the end frame and then goes back', async ({ page }) => {
    await openUniverse(page);
    await expect(system(page)).toBeVisible({ timeout: 60_000 });
    await tapOrbitingTarget(system(page));
    await expect(page.getByTestId('universe-tap-ring')).toBeAttached();
    await page.waitForTimeout(600);
    await page.getByRole('button', { name: 'Back to Universe', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Your universe', exact: true })).toBeVisible();
    await expect(page.getByTestId('universe-tap-ring')).toHaveCount(0);
  });

  test('under reduced motion none of them plays: the destination is shown at once', async ({ page }) => {
    const written = await openUniverse(page, { reducedMotion: true, claim: true });
    await expect(system(page)).toBeVisible({ timeout: 60_000 });
    await tapOrbitingTarget(system(page));
    await expect(page.getByRole('heading', { level: 1, name: 'CI system 0', exact: true })).toBeVisible();
    await expect(page.getByTestId('universe-tap-ring')).toHaveCount(0);
    await tapOrbitingTarget(planet(page));
    await expect(page.getByTestId('universe-globe-layer')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Land on CI planet 2', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Land on CI planet 2', exact: true }).click();
    await expect(page.getByTestId('universe-world-layers')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'CI region 4, a region', exact: true })).toBeVisible();
    // The one opening is not used up on a device that cannot show it.
    expect(written.claims).toHaveLength(0);
  });
});

test.describe('the first open', () => {
  test('plays once for the account, whole, claiming it only once its picture can be drawn, and ends on the tab it was drawing beneath', async ({
    page,
  }, testInfo) => {
    const written = await openUniverse(page, { claim: true });
    await expect(page.getByTestId('first-open')).toBeVisible({ timeout: 60_000 });
    expect(written.claims).toHaveLength(1);
    const start = await mark(page);
    await page.waitForTimeout(3000);
    if (shots) await page.screenshot({ path: `${shots}/first-open-3s-390x844.png` });
    await expectAccessible(page);
    await page.waitForTimeout(3300);
    if (shots) await page.screenshot({ path: `${shots}/first-open-6.3s-390x844.png` });
    // The whole picture runs to its end by itself: nothing here presses Skip.
    await expect(page.getByTestId('first-open')).toHaveCount(0, OPENING);
    await expectCapped(page, start, await mark(page));
    await expect(system(page)).toBeVisible();
    // Reloaded, the device knows the account has seen it and does not even ask.
    await page.reload();
    await expect(system(page)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('first-open')).toHaveCount(0);
    expect(written.claims).toHaveLength(1);
    expect(testInfo.errors).toEqual([]);
  });

  test('Skip is always there, ends it at once, and counts as seen', async ({ page }) => {
    const written = await openUniverse(page, { claim: true });
    await expect(page.getByTestId('first-open')).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(2500);
    if (shots) await page.screenshot({ path: `${shots}/first-open-skip-390x844.png` });
    await page.getByRole('button', { name: 'Skip the opening', exact: true }).click();
    await expect(page.getByTestId('first-open')).toHaveCount(0);
    await expect(system(page)).toBeVisible({ timeout: 30_000 });
    await page.reload();
    await expect(system(page)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('first-open')).toHaveCount(0);
    expect(written.claims).toHaveLength(1);
  });

  test('ends on the empty universe for an account with no places, rising into it', async ({ page }) => {
    await openUniverse(page, { claim: true, places: false });
    await expect(page.getByTestId('first-open')).toBeVisible({ timeout: 60_000 });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('first-open')).toHaveCount(0);
    await expect(page.getByText('Your universe starts quiet.')).toBeVisible();
  });

  test('does not play on the desktop layout, and leaves the opening unused', async ({ page }) => {
    const written = await openUniverse(page, { claim: true, size: { width: 1440, height: 900 } });
    await expect(system(page)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('first-open')).toHaveCount(0);
    expect(written.claims).toHaveLength(0);
  });
});

test.describe('at 1440 x 900 (D02)', () => {
  test('a pick docks in the panel and no step down is animated', async ({ page }) => {
    await openUniverse(page, { size: { width: 1440, height: 900 } });
    await expect(system(page)).toBeVisible({ timeout: 60_000 });
    await tapOrbitingTarget(system(page));
    await expect(page.getByRole('heading', { level: 1, name: 'CI system 0', exact: true })).toBeVisible();
    await expect(page.getByTestId('universe-tap-ring')).toHaveCount(0);
    await expectAccessible(page);
    if (shots) await page.screenshot({ path: `${shots}/enter-system-end-1440x900.png` });
  });
});
