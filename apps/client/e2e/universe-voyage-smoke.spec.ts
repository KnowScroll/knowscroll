import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { COLLECTION_READS, fixtureAccount, sceneFixture } from '../features/universe/universe.fixture';
import { emptyInbox, isInboxPath } from './empty-inbox';
import { tapOrbitingTarget } from './orbiting-target';

/**
 * The Universe's Round 7.3 look on trial (#811), in a real browser with a real WebGL 2 context over authored HTTP
 * fixtures: with "Try the new Universe" on, one camera flies from the whole universe to a star, a planet and its
 * ground; every place is still a named button over the canvas; the Back pill climbs one stop at a time; land not
 * reached yet is never read out; and browsing sends no write. With the switch off the Universe is as it was.
 */
const READS = new Set([
  '/v1/universe/geography/read',
  '/v1/universe/geography/deltas/read',
  '/v1/universe/scenes/sky/read',
  '/v1/universe/scenes/manifest/read',
  '/v1/universe/scenes/chunks/read',
  '/v1/universe/emerging/read',
  '/v1/experience/region/preview',
  '/v1/universe/formation/read',
  '/v1/rooms/stations',
  ...COLLECTION_READS,
]);

interface Options {
  readonly size?: { width: number; height: number };
  readonly trial?: boolean;
  readonly calm?: boolean;
}

/** Screenshots are written only when `KS_UNIVERSE_SHOTS` names a folder (outside the repository). */
async function shot(page: Page, name: string): Promise<void> {
  const folder = process.env['KS_UNIVERSE_SHOTS'];
  if (folder === undefined) return;
  mkdirSync(folder, { recursive: true });
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(folder, `${name}.png`) });
}

async function openUniverse(page: Page, paths: string[], options: Options = {}): Promise<void> {
  // Three systems, and a planet with four formed regions.
  const world = sceneFixture(5, 0, 3, 2);
  await page.setViewportSize(options.size ?? { width: 390, height: 844 });
  if (options.calm === true) await page.emulateMedia({ reducedMotion: 'reduce' });
  if (options.trial !== false)
    await page.addInitScript(() =>
      window.localStorage.setItem(
        'ks.device.preferences',
        JSON.stringify({ universeTrial: true, universeFrameRate: true }),
      ),
    );
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
    if (!isInboxPath(path) || path === '/v1/rooms/stations') paths.push(path);
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

/** The readout's two lines as one, for the pull request. */
const readoutOf = async (page: Page): Promise<string> =>
  (await page.getByTestId('universe-frame-rate').innerText()).replace(/\s+/g, ' ');

test('flies from the whole universe to a star, a planet and its ground, and climbs back one stop at a time', async ({
  page,
}, testInfo) => {
  // Every flight is drawn in software here, at a few frames a second when the runner is busy.
  test.setTimeout(240_000);
  const paths: string[] = [];
  await openUniverse(page, paths);
  await expect(page.getByTestId('voyage-stage')).toBeVisible({ timeout: 60_000 });
  const system = page.getByRole('button', { name: 'CI system 0, a system', exact: true });
  await expect(system).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('universe-simple')).toHaveCount(0);
  await page.waitForTimeout(2500);
  const numbers = [`universe: ${await readoutOf(page)}`];
  await shot(page, 'voyage-1-universe');

  await system.click();
  await expect(page.getByRole('heading', { level: 1, name: 'CI system 0', exact: true })).toBeVisible();
  const planet = page.getByRole('button', { name: 'CI planet 2, a planet', exact: true });
  await expect(planet).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(3500);
  numbers.push(`star: ${await readoutOf(page)}`);
  await shot(page, 'voyage-2-star');

  await tapOrbitingTarget(planet);
  await expect(page.getByRole('heading', { level: 1, name: 'CI planet 2', exact: true })).toBeVisible();
  await page.waitForTimeout(3500);
  await shot(page, 'voyage-3-planet');
  // The globe turns slowly: some of its regions face you, each a named button.
  await expect(page.getByRole('button', { name: /^CI region \d, a region$/ }).first()).toBeVisible({ timeout: 30_000 });
  numbers.push(`planet: ${await readoutOf(page)}`);

  // One stop in by key: the camera falls to the ground on the same world.
  await page.getByTestId('voyage-stage').focus();
  await page.keyboard.press('+');
  await expect(page.getByRole('button', { name: 'Back to CI planet 2', exact: true })).toBeVisible();
  await page.waitForTimeout(3500);
  numbers.push(`ground: ${await readoutOf(page)}`);
  await shot(page, 'voyage-4-ground');
  // On the ground the camera has come down over the first formed region.
  await expect(page.getByRole('button', { name: 'CI region 4, a region', exact: true })).toBeVisible();

  // Land not reached yet is drawn grey but never named, read out or given a button: the only regions are the formed ones.
  const tree = await page.locator('body').ariaSnapshot();
  expect(tree).not.toMatch(/uncharted|not reached|unreached|locked|grey|gray/i);
  const regions = await page
    .getByRole('button', { name: /, a region$/ })
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
  expect(regions.length).toBeGreaterThan(0);
  for (const name of regions) expect(name).toMatch(/^CI region [4-7], a region$/);

  // The Back pill climbs one stop: the ground to the planet, the planet to the star, the star to the universe.
  await page.getByRole('button', { name: 'Back to CI planet 2', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Back to CI system 0', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to CI system 0', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Back to Universe', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to Universe', exact: true }).click();
  await expect(system).toBeVisible({ timeout: 30_000 });

  expect(paths.filter((path) => !READS.has(path))).toEqual([]);
  const line = `voyage (web, 390x844, software WebGL): ${numbers.join(' | ')}`;
  // eslint-disable-next-line no-console -- the numbers go in the pull request
  console.log(line);
  await testInfo.attach('voyage-frame-numbers', { body: line, contentType: 'text/plain' });
});

test('with reduced motion every stop is drawn at once, and the globe’s regions are still there', async ({ page }) => {
  test.setTimeout(180_000);
  await openUniverse(page, [], { calm: true });
  await page.getByRole('button', { name: 'CI system 0, a system', exact: true }).click({ timeout: 60_000 });
  const planet = page.getByRole('button', { name: 'CI planet 2, a planet', exact: true });
  await expect(planet).toBeVisible({ timeout: 30_000 });
  await planet.click();
  await shot(page, 'voyage-5-planet-reduced-motion');
  await expect(page.getByRole('button', { name: /^CI region \d, a region$/ }).first()).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('voyage-stage').focus();
  await page.keyboard.press('+');
  await expect(page.getByRole('button', { name: 'CI region 4, a region', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await shot(page, 'voyage-5-ground-reduced-motion');
});

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true, isMobile: true });

  /** Two fingers on the stage, `from` px apart, spread or closed to `to` px about a point, then lifted. */
  async function pinch(page: Page, at: { x: number; y: number }, from: number, to: number): Promise<void> {
    const cdp = await page.context().newCDPSession(page);
    const fingers = (spread: number) => [
      { x: at.x - spread / 2, y: at.y, id: 0 },
      { x: at.x + spread / 2, y: at.y, id: 1 },
    ];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: fingers(from) });
    for (let step = 1; step <= 8; step += 1)
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: fingers(from + ((to - from) * step) / 8),
      });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  }

  test('a two-finger pinch moves one stop and never zooms the page', async ({ page }) => {
    test.setTimeout(180_000);
    await openUniverse(page, []);
    const stage = page.getByTestId('voyage-stage');
    // The browser leaves every touch on the stage to the Universe: no page zoom, no scroll, no pull to refresh.
    await expect(stage).toHaveCSS('touch-action', 'none');
    const system = page.getByRole('button', { name: 'CI system 0, a system', exact: true });
    await expect(system).toBeVisible({ timeout: 60_000 });

    // Two fingers that rest on a system without spreading are no tap on it: the camera stays where it is.
    const box = await system.boundingBox();
    if (box === null) throw new Error('The system has no box to pinch over');
    const over = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await pinch(page, over, 60, 60);
    await page.waitForTimeout(1000);
    await expect(page.getByRole('heading', { level: 1, name: 'CI system 0', exact: true })).toHaveCount(0);

    // Spreading them over it goes down one stop, to its star.
    await pinch(page, over, 60, 220);
    await expect(page.getByRole('heading', { level: 1, name: 'CI system 0', exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole('button', { name: 'CI planet 2, a planet', exact: true })).toBeVisible({
      timeout: 30_000,
    });

    // Closing them climbs one stop, back to the whole universe.
    await pinch(page, { x: 195, y: 422 }, 220, 60);
    await expect(page.getByRole('button', { name: 'Back to Universe', exact: true })).toHaveCount(0, {
      timeout: 30_000,
    });
    await expect(system).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1);
  });
});

test('with the trial switch off the Universe is the one that ships', async ({ page }) => {
  await openUniverse(page, [], { trial: false });
  await expect(page.getByRole('button', { name: 'CI system 0, a system', exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId('voyage-stage')).toHaveCount(0);
});
