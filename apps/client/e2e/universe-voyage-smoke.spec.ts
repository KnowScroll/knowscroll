import { expect, test, type Page } from '@playwright/test';
import { tapOrbitingTarget } from './orbiting-target';
import {
  frameLine,
  frameStamps,
  landed,
  openVoyage,
  programCounts,
  readoutOf,
  shot,
  VOYAGE_READS,
} from './voyage-fixture';

/** How much of each flight is measured: its first 3 s, about the longest flight between two neighbouring stops. */
const FLIGHT_MS = 3000;

/** The frames of the flight that started after stamp number `from`. */
async function flightFrom(page: Page, from: number): Promise<string> {
  const stamps = (await frameStamps(page)).slice(from);
  const start = stamps[0] ?? 0;
  return frameLine(stamps.filter((stamp) => stamp - start <= FLIGHT_MS));
}

/**
 * The Universe's Round 7.3 look on trial (#811), in a real browser with a real WebGL 2 context over authored HTTP
 * fixtures: with "Try the new Universe" on, one camera flies from the whole universe to a star, a planet and its
 * ground; every place is still a named button over the canvas; the Back pill climbs one stop at a time; land not
 * reached yet is never read out; and browsing sends no write. With the switch off the Universe is as it was.
 */
test('flies from the whole universe to a star, a planet and its ground, and climbs back one stop at a time', async ({
  page,
}, testInfo) => {
  // Every flight is drawn in software here, at a few frames a second when the runner is busy.
  test.setTimeout(240_000);
  const paths: string[] = [];
  await openVoyage(page, paths, { stamps: true, programs: true });
  await expect(page.getByTestId('voyage-stage')).toBeVisible({ timeout: 60_000 });
  const system = page.getByRole('button', { name: 'CI system 0, a system', exact: true });
  await expect(system).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('universe-simple')).toHaveCount(0);
  await page.waitForTimeout(2500);
  const programsAtRest = await programCounts(page);
  const numbers = [`universe: ${await readoutOf(page)}`];
  await shot(page, 'voyage-1-universe');

  const flights: string[] = [];
  let from = (await frameStamps(page)).length;
  await system.click();
  await expect(page.getByRole('heading', { level: 1, name: 'CI system 0', exact: true })).toBeVisible();
  const planet = page.getByRole('button', { name: 'CI planet 2, a planet', exact: true });
  await expect(planet).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(3500);
  flights.push(`to the star: ${await flightFrom(page, from)}`);
  numbers.push(`star: ${await readoutOf(page)}`);
  await shot(page, 'voyage-2-star');

  from = (await frameStamps(page)).length;
  await landed(page);
  await tapOrbitingTarget(planet);
  await expect(page.getByRole('heading', { level: 1, name: 'CI planet 2', exact: true })).toBeVisible();
  await page.waitForTimeout(3500);
  flights.push(`to the planet: ${await flightFrom(page, from)}`);
  await shot(page, 'voyage-3-planet');
  // The globe turns slowly: some of its regions face you, each a named button.
  await expect(page.getByRole('button', { name: /^CI region \d, a region$/ }).first()).toBeVisible({ timeout: 30_000 });
  numbers.push(`planet: ${await readoutOf(page)}`);

  // One stop in by key: the camera falls to the ground on the same world.
  await page.getByTestId('voyage-stage').focus();
  from = (await frameStamps(page)).length;
  await page.keyboard.press('+');
  await expect(page.getByRole('button', { name: 'Back to CI planet 2', exact: true })).toBeVisible();
  await page.waitForTimeout(3500);
  flights.push(`to the ground: ${await flightFrom(page, from)}`);
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
  from = (await frameStamps(page)).length;
  await page.getByRole('button', { name: 'Back to CI planet 2', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Back to CI system 0', exact: true })).toBeVisible();
  await page.waitForTimeout(3500);
  flights.push(`up to the planet: ${await flightFrom(page, from)}`);
  await page.getByRole('button', { name: 'Back to CI system 0', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Back to Universe', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to Universe', exact: true }).click();
  await expect(system).toBeVisible({ timeout: 30_000 });

  // No flight rebuilds the scene: a rebuild frees every shader program and links it again, a stall mid-flight.
  const programs = await programCounts(page);
  expect(programs.deleted - programsAtRest.deleted).toBe(0);

  expect(paths.filter((path) => !VOYAGE_READS.has(path))).toEqual([]);
  const linked = programs.linked - programsAtRest.linked;
  const line = `voyage (web, 390x844, software WebGL): stops ${numbers.join(' | ')}; flights ${flights.join(' | ')}; programs linked in flight ${linked}`;
  // eslint-disable-next-line no-console -- the numbers go in the pull request
  console.log(line);
  await testInfo.attach('voyage-frame-numbers', { body: line, contentType: 'text/plain' });
});

test('a flight says where it is going, and a tap skips to its end', async ({ page }) => {
  test.setTimeout(180_000);
  await openVoyage(page, []);
  const system = page.getByRole('button', { name: 'CI system 0, a system', exact: true });
  await expect(system).toBeVisible({ timeout: 60_000 });
  await system.click();
  // Read out once, and a test's way of knowing a flight is under way.
  await expect(page.getByTestId('voyage-flight')).toHaveText('Going to CI system 0 · tap to skip');
  await page.getByRole('button', { name: 'Skip the flight to CI system 0', exact: true }).click();
  await landed(page);
  await expect(page.getByRole('button', { name: 'CI planet 2, a planet', exact: true })).toBeVisible();
});

test('with reduced motion every stop is drawn at once, and the globe’s regions are still there', async ({ page }) => {
  test.setTimeout(180_000);
  await openVoyage(page, [], { calm: true });
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

test('Escape on the ground climbs one stop, to the planet’s globe, as the Back pill does', async ({ page }) => {
  test.setTimeout(180_000);
  await openVoyage(page, [], { calm: true });
  await page.getByRole('button', { name: 'CI system 0, a system', exact: true }).click({ timeout: 60_000 });
  await page.getByRole('button', { name: 'CI planet 2, a planet', exact: true }).click({ timeout: 30_000 });
  await page.getByTestId('voyage-stage').focus();
  await page.keyboard.press('+');
  await expect(page.getByRole('button', { name: 'Back to CI planet 2', exact: true })).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Back to CI system 0', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'CI planet 2', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Back to Universe', exact: true })).toBeVisible();
});

/** Ways the new look cannot draw, each prepared before the page loads; every one must end in the plain lists (D-111). */
const NO_3D: readonly (readonly [string, () => void])[] = [
  [
    'the browser has no WebGL',
    () => {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- called back with the right `this` below
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
        return kind === 'webgl2' || kind === 'webgl'
          ? null
          : (getContext as (...args: unknown[]) => unknown).call(this, kind, ...rest);
      } as never;
    },
  ],
  ['the device is short of memory', () => Object.defineProperty(navigator, 'deviceMemory', { value: 0.5 })],
];

for (const [why, prepare] of NO_3D)
  test(`with the trial on, opens as the plain lists when ${why}`, async ({ page }) => {
    await page.addInitScript(prepare);
    await openVoyage(page, []);
    await expect(page.getByTestId('universe-simple')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('heading', { level: 2, name: 'CI system 0', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'CI planet 2, a planet in CI system 0', exact: true })).toBeVisible();
  });

test('with the trial on, a lost WebGL context at a star swaps in the plain lists of that star', async ({ page }) => {
  test.setTimeout(120_000);
  await openVoyage(page, [], { calm: true });
  await page.getByRole('button', { name: 'CI system 0, a system', exact: true }).click({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'CI planet 2, a planet', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await page.locator('canvas').evaluate((canvas: HTMLCanvasElement) => {
    const extension = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context');
    if (!extension) throw new Error('Context loss extension must be available for this browser check');
    extension.loseContext();
  });
  await expect(page.getByTestId('universe-simple')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'CI system 0', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'CI planet 2, a planet in CI system 0', exact: true })).toBeVisible();
});

/**
 * What the Universe screen paints, in page order: the colour of each visible piece of text, each background that is not
 * transparent, each border that has a width, and each SVG shape's fill and stroke. The tab bar and the rest of the app
 * follow the appearance; the Universe screen does not (D-400). Inherited colour on an empty box is not painted, so it
 * is left out. So is the frame-rate readout: its words change with time, so two runs never read alike.
 */
const universeColours = (page: Page): Promise<string[]> =>
  page.getByTestId('voyage-stage').evaluate((stage) => {
    const screen = stage.closest('[data-ks-appearance]') ?? stage;
    const painted: string[] = [];
    for (const element of screen.querySelectorAll<HTMLElement | SVGElement>('*')) {
      if (element.closest('[data-testid="universe-frame-rate"]')) continue;
      if (!element.checkVisibility() || element.getBoundingClientRect().width === 0) continue;
      const style = getComputedStyle(element);
      const name = element.tagName.toLowerCase();
      const ownText = [...element.childNodes].some((node) => node.nodeType === 3 && (node.textContent ?? '').trim());
      if (ownText) painted.push(`${name} "${(element.textContent ?? '').trim().slice(0, 24)}" text ${style.color}`);
      if (style.backgroundColor !== 'rgba(0, 0, 0, 0)') painted.push(`${name} background ${style.backgroundColor}`);
      if (parseFloat(style.borderTopWidth) > 0) painted.push(`${name} border ${style.borderTopColor}`);
      if (element instanceof SVGElement && name !== 'svg')
        painted.push(`${name} fill ${style.fill} stroke ${style.stroke}`);
    }
    return painted;
  });

test('looks the same in Light and in Dark, at every stop and in the region card (D-400)', async ({ browser }) => {
  test.setTimeout(240_000);
  const seen: Record<string, string[][]> = {};
  for (const appearance of ['light', 'dark'] as const) {
    const page = await browser.newPage();
    await openVoyage(page, [], { calm: true, appearance });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-ks-appearance')))
      .toBe(appearance);
    const stops: string[][] = [];
    const system = page.getByRole('button', { name: 'CI system 0, a system', exact: true });
    await expect(system).toBeVisible({ timeout: 60_000 });
    stops.push(await universeColours(page));
    await system.click();
    await page.getByRole('button', { name: 'CI planet 2, a planet', exact: true }).click({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: /^CI region \d, a region$/ }).first()).toBeVisible({
      timeout: 30_000,
    });
    stops.push(await universeColours(page));
    await page.getByTestId('voyage-stage').focus();
    await page.keyboard.press('+');
    const region = page.getByRole('button', { name: 'CI region 4, a region', exact: true });
    await expect(region).toBeVisible({ timeout: 30_000 });
    await region.click();
    await page.waitForTimeout(1500);
    stops.push(await universeColours(page));
    await shot(page, `voyage-6-region-card-${appearance}`);
    seen[appearance] = stops;
    await page.close();
  }
  // Something was read at every stop, so the comparison below compares the screen and not two empty lists.
  for (const stop of seen['light'] ?? []) expect(stop.length).toBeGreaterThan(5);
  expect(seen['light']).toHaveLength(3);
  expect(seen['light']).toEqual(seen['dark']);
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
    await openVoyage(page, []);
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
    await landed(page);
    await pinch(page, { x: 195, y: 422 }, 220, 60);
    await expect(page.getByRole('button', { name: 'Back to Universe', exact: true })).toHaveCount(0, {
      timeout: 30_000,
    });
    await expect(system).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1);
  });
});

test('with the trial switch off the Universe is the one that ships', async ({ page }) => {
  await openVoyage(page, [], { trial: false });
  await expect(page.getByRole('button', { name: 'CI system 0, a system', exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId('voyage-stage')).toHaveCount(0);
});
