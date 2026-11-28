import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { tapOrbitingTarget } from './orbiting-target';
import { landed, openVoyage, programCounts, shot, VOYAGE_READS, type VoyageOptions } from './voyage-fixture';

/**
 * The planet's two maps wired into the Universe's new look (#811), in a real browser over authored HTTP fixtures: a
 * planet with four formed regions ("CI region 4" to "CI region 7") among land not reached yet. From the ground a chip,
 * the `M` key and a tap on bare ground open the map of the whole planet; a row or the name of a region opens that
 * region's own map; Back, Escape and the browser's Back each go one step. Looking writes nothing. Set
 * `KS_UNIVERSE_SHOTS` to a folder to save the frames.
 */
const SIZES = [
  { label: 'phone', width: 390, height: 844 },
  { label: 'desktop', width: 1440, height: 900 },
] as const;
type Size = (typeof SIZES)[number];

/** Words the maps must never say: land that is not reached is not named, counted or announced (D-109). */
const CLOSED_LAND = /uncharted|not reached|unreached|locked|grey|gray/i;

const MAP = 'Map of CI planet 2';
const chip = (page: Page) => page.getByRole('button', { name: MAP, exact: true });
const screenOf = (page: Page) => page.getByTestId('map-screen');
const region = (page: Page, n: number) => page.getByRole('button', { name: `CI region ${String(n)}, a region` });

/** Flies to CI planet 2's ground, where the chip stands. Reduced motion draws every stop at once. */
async function toGround(page: Page, size: Size, paths: string[], options: VoyageOptions = {}): Promise<void> {
  await openVoyage(page, paths, { size, calm: true, alternate: true, ...options });
  const system = page.getByRole('button', { name: 'CI system 0, a system', exact: true });
  await expect(system).toBeVisible({ timeout: 60_000 });
  await system.click();
  const planet = page.getByRole('button', { name: 'CI planet 2, a planet', exact: true });
  await expect(planet).toBeVisible({ timeout: 30_000 });
  await tapOrbitingTarget(planet);
  await expect(page.getByRole('button', { name: /^CI region \d, a region$/ }).first()).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('voyage-stage').focus();
  await page.keyboard.press('+');
  await expect(chip(page)).toBeVisible({ timeout: 30_000 });
  await landed(page);
}

/** A point of the ground at 390 x 844 and at 1440 x 900 over CI region 4's land, and one over open sea (calm, so the same every run). */
const LAND_ON_GROUND = { phone: { x: 200, y: 250 }, desktop: { x: 1000, y: 350 } } as const;
const SEA_ON_GROUND = { phone: { x: 8, y: 450 }, desktop: { x: 200, y: 300 } } as const;

/** The point is on the ground's press layer, so no name, chip or ship is on top of it. */
const ownedByGroundPress = (page: Page, at: { x: number; y: number }): Promise<boolean> =>
  page.evaluate(
    ([x, y]) => document.elementFromPoint(x!, y!)?.closest('[data-testid="voyage-ground-press"]') !== null,
    [at.x, at.y],
  );

/** Flies to CI planet 2's globe, the planet stop. Reduced motion turns it to face its first region and holds it still. */
async function toPlanetStop(page: Page, size: Size): Promise<void> {
  await openVoyage(page, [], { size, calm: true, alternate: true });
  const system = page.getByRole('button', { name: 'CI system 0, a system', exact: true });
  await expect(system).toBeVisible({ timeout: 60_000 });
  await system.click();
  const planet = page.getByRole('button', { name: 'CI planet 2, a planet', exact: true });
  await expect(planet).toBeVisible({ timeout: 30_000 });
  await tapOrbitingTarget(planet);
  await expect(page.getByRole('button', { name: /^CI region \d, a region$/ }).first()).toBeVisible({ timeout: 30_000 });
  await landed(page);
  await expect(page.getByTestId('voyage-globe-press')).toHaveCount(1);
  await page.waitForTimeout(1200);
}

/** Whether the planet stop's press layer is what is under a point. */
const ownedByGlobePress = (page: Page, at: { x: number; y: number }): Promise<boolean> =>
  page.evaluate(
    ([x, y]) => document.elementFromPoint(x!, y!)?.closest('[data-testid="voyage-globe-press"]') !== null,
    [at.x, at.y],
  );

test.describe('at the planet stop (390 x 844)', () => {
  /** CI region 7's land, up and left of its name, which stands about (278, 362); the globe is at about (195, 348) with a radius of 142. */
  const REGION_7_LAND = { x: 249, y: 319 };
  const GLOBE_SEA = { x: 114, y: 397 };
  const SKY = { x: 60, y: 215 };

  test('a tap on a region’s land, away from its name, reaches that region as its name does', async ({ page }) => {
    test.setTimeout(240_000);
    await toPlanetStop(page, SIZES[0]);
    const name = await region(page, 7).boundingBox();
    expect(name).not.toBeNull();
    // Not on the name's button: the press layer is what is under the finger, and it is further than a button from the name.
    expect(await ownedByGlobePress(page, REGION_7_LAND)).toBe(true);
    expect(Math.hypot(REGION_7_LAND.x - (name!.x + 24), REGION_7_LAND.y - (name!.y + 24))).toBeGreaterThan(40);
    await shot(page, 'regions-2-planet-before-tap');
    await page.mouse.click(REGION_7_LAND.x, REGION_7_LAND.y);
    await expect(mapNamed(page, 'CI region 7, a region of CI planet 2')).toBeVisible();
    await expect(mapNamed(page, MAP)).toHaveCount(0);
    await expectNothingClosed(page);
    await shot(page, 'regions-3-planet-after-tap');
  });

  test('a tap on the globe’s sea lands on the planet, and a tap in the sky round it does nothing', async ({ page }) => {
    test.setTimeout(240_000);
    await toPlanetStop(page, SIZES[0]);
    expect(await ownedByGlobePress(page, SKY)).toBe(true);
    await page.mouse.click(SKY.x, SKY.y);
    // Nothing can be waited on when nothing happens: a flight would show its line, and the stop would change.
    await page.waitForTimeout(1500);
    await expect(page.getByRole('button', { name: 'Back to CI system 0', exact: true })).toBeVisible();
    await expect(page.getByTestId('voyage-globe-press')).toHaveCount(1);

    expect(await ownedByGlobePress(page, GLOBE_SEA)).toBe(true);
    await page.mouse.click(GLOBE_SEA.x, GLOBE_SEA.y);
    await expect(chip(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Back to CI planet 2', exact: true })).toBeVisible();
    await expect(screenOf(page)).toHaveCount(0);
  });

  test('a region’s name still works, and the press layer is neither named nor a tab stop', async ({ page }) => {
    test.setTimeout(240_000);
    await toPlanetStop(page, SIZES[0]);
    const layer = page.getByTestId('voyage-globe-press');
    await expect(layer).toHaveAttribute('tabindex', '-1');
    await expect(layer).toHaveAttribute('aria-hidden', 'true');
    await expectNoSeriousViolations(page);
    await region(page, 5).click();
    await expect(mapNamed(page, 'CI region 5, a region of CI planet 2')).toBeVisible();
  });
});

test('on the planet’s map every region is a target of at least 44 points and the nearest wins near its edge', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await toGround(page, SIZES[0], []);
  await openMapByChip(page);
  await expect(page.getByTestId('flat-planet-press')).toHaveCount(1);
  await expect(page.getByTestId('flat-planet-press')).toHaveAttribute('tabindex', '-1');
  // Each formed region's dashed border is one path: where each region is on the page, in points.
  const boxes = await page.locator('[data-testid="flat-planet"] path[stroke-dasharray]').evaluateAll((paths) =>
    paths.map((path) => {
      const { x, y, width, height } = path.getBoundingClientRect();
      return { x, y, width, height };
    }),
  );
  expect(boxes).toHaveLength(4);
  // CI region 5 is the westmost of the four. A tap 10 points beyond its western edge, level with its middle, is on the
  // sea: no land is under it, but it is within the 24 points that choose the nearest region.
  const west = boxes[1]!;
  expect(west.x).toBeLessThan(Math.min(...boxes.filter((box) => box !== west).map((box) => box.x)));
  const near = { x: west.x - 10, y: west.y + west.height / 2 };
  await shot(page, 'regions-4-map-before-near-tap');
  await page.mouse.click(near.x, near.y);
  await expect(mapNamed(page, 'CI region 5, a region of CI planet 2')).toBeVisible();
});

test('a tap on the planet’s map far from every region chooses nothing', async ({ page }) => {
  test.setTimeout(240_000);
  await toGround(page, SIZES[0], []);
  await openMapByChip(page);
  const drawing = await page.getByTestId('flat-planet').boundingBox();
  expect(drawing).not.toBeNull();
  // The top left corner of the band is open sea, far from the formed regions.
  await page.mouse.click(drawing!.x + 8, drawing!.y + 8);
  await page.waitForTimeout(800);
  await expect(mapNamed(page, MAP)).toBeVisible();
});

/** Axe over the whole page; serious and critical findings fail. */
async function expectNoSeriousViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => ({ rule: v.id, nodes: v.nodes.map((node) => node.target.join(' ')) }))).toEqual([]);
}

/** What a map says, for a person and for assistive technology: nothing about closed land, and only formed regions named. */
async function expectNothingClosed(page: Page): Promise<void> {
  const tree = await screenOf(page).ariaSnapshot();
  expect(tree).not.toMatch(CLOSED_LAND);
  const names = [...new Set(tree.match(/CI region \d+/g) ?? [])];
  for (const name of names) expect(name).toMatch(/^CI region [4-7]$/);
  const text = await screenOf(page).innerText();
  expect(text).not.toMatch(CLOSED_LAND);
  // Never "N of M": nothing here says how much is left.
  expect(text).not.toMatch(/\d+\s+of\s+\d+/i);
}

/** The ground's chip opens map 1 and focus moves into it. */
async function openMapByChip(page: Page): Promise<void> {
  await chip(page).click();
  await expect(screenOf(page)).toBeVisible();
  await expect(screenOf(page)).toHaveAttribute('aria-label', MAP);
  // The stage is still mounted, and out of reach of the keyboard and of assistive technology.
  await expect(page.getByTestId('universe-map')).toHaveAttribute('inert', '');
}

/** Whether a map is up, by the name it calls itself. */
const mapNamed = (page: Page, name: string) => screenOf(page).and(page.locator(`[aria-label="${name}"]`));

for (const size of SIZES) {
  test.describe(`at ${size.label} (${String(size.width)} x ${String(size.height)})`, () => {
    test('the chain: the ground, map 1, a region’s map from a row, then Back one step at a time', async ({ page }) => {
      test.setTimeout(240_000);
      const paths: string[] = [];
      await toGround(page, size, paths, { programs: true });
      const programsAtRest = await programCounts(page);
      await shot(page, `maps-1-ground-chip-${size.label}`);
      // The chip is beside the other chips, and the keyboard hints (desktop) say the key.
      if (size.label === 'desktop') await expect(page.getByTestId('universe-key-hints')).toContainText('M');
      await expect(page.getByTestId('voyage-ground-press')).toHaveCount(1);

      const reads = paths.length;
      await openMapByChip(page);
      await expect(mapNamed(page, MAP)).toBeVisible();
      // Looking at the whole planet reads and writes nothing, and the chip and the header are not behind it.
      expect(paths.length).toBe(reads);
      await expect(chip(page)).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Back to CI system 0' })).toHaveCount(0);
      const rows = await page
        .getByRole('button', { name: /, a region$/ })
        .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
      expect(rows).toEqual([
        'CI region 4, a region',
        'CI region 5, a region',
        'CI region 6, a region',
        'CI region 7, a region',
      ]);
      await expectNothingClosed(page);
      await expectNoSeriousViolations(page);
      await shot(page, `maps-2-planet-map-${size.label}`);

      await region(page, 5).click();
      await expect(mapNamed(page, 'CI region 5, a region of CI planet 2')).toBeVisible();
      await expect(page.getByTestId('universe-region-card')).toHaveCount(0);
      await expect(page.getByTestId('map-contents')).toBeVisible();
      // Exactly one read: the preview a card does, and nothing is sent that is not a read.
      await expect.poll(() => paths.filter((path) => path.endsWith('/region/preview')).length).toBe(1);
      await expect(page.getByTestId('map-open')).toBeVisible();
      await expect(page.getByTestId('map-alternate')).toHaveText('Read as a Scroll');
      await expectNothingClosed(page);
      await expectNoSeriousViolations(page);
      await shot(page, `maps-3-region-from-row-${size.label}`);

      // Back: the region's map to the planet's, then the planet's to the ground it was opened from.
      await page.getByRole('button', { name: 'Back to Map of CI planet 2' }).click();
      await expect(mapNamed(page, MAP)).toBeVisible();
      await shot(page, `maps-4-back-to-map-${size.label}`);
      await page.getByRole('button', { name: 'Back to CI planet 2' }).click();
      await expect(screenOf(page)).toHaveCount(0);
      await expect(chip(page)).toBeFocused();
      await expect(page.getByTestId('universe-map')).not.toHaveAttribute('inert', '');
      await landed(page);
      await shot(page, `maps-5-back-to-ground-${size.label}`);

      // Nothing was drawn again: a rebuilt scene frees every shader program and links it again.
      expect((await programCounts(page)).deleted - programsAtRest.deleted).toBe(0);
      expect(paths.filter((path) => !VOYAGE_READS.has(path))).toEqual([]);
    });

    test('a region’s name on the ground opens its own map at once, and Back returns to the region’s ground', async ({
      page,
    }) => {
      test.setTimeout(240_000);
      await toGround(page, size, []);
      await region(page, 4).click();
      await expect(mapNamed(page, 'CI region 4, a region of CI planet 2')).toBeVisible();
      await expect(page.getByTestId('universe-region-card')).toHaveCount(0);
      // Opened from the ground, Back goes to the region's ground, not to a map that was never open.
      await expect(page.getByRole('button', { name: 'Back to CI planet 2' })).toBeVisible();
      await shot(page, `maps-6-region-from-name-${size.label}`);
      await expectNothingClosed(page);
      await page.getByRole('button', { name: 'Back to CI planet 2' }).click();
      await expect(screenOf(page)).toHaveCount(0);
      await expect(chip(page)).toBeFocused();
      await landed(page);
    });

    test('M on the focused stage and a tap on bare ground open the map; a drag turns the land and opens nothing', async ({
      page,
    }) => {
      test.setTimeout(240_000);
      await toGround(page, size, []);
      await page.getByTestId('voyage-stage').focus();
      await page.keyboard.press('m');
      await expect(mapNamed(page, MAP)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(screenOf(page)).toHaveCount(0);
      await landed(page);

      // A spot of sea where nothing is named and no chrome stands: the press layer is what is under the finger. (Land
      // under the finger would be a tap on a region, which opens that region's map, not this one.)
      const spot = { ...SEA_ON_GROUND[size.label] };
      expect(await ownedByGroundPress(page, spot)).toBe(true);
      // A drag past the turn threshold is a turn of the land, not a press.
      await page.mouse.move(spot.x, spot.y);
      await page.mouse.down();
      // The coast runs up and down here, so a drag up and down keeps the sea under the spot.
      for (let step = 1; step <= 6; step++) await page.mouse.move(spot.x, spot.y + step * 3, { steps: 2 });
      await page.mouse.up();
      await expect(screenOf(page)).toHaveCount(0);
      // The stage treats a press within 350 ms of a gesture as the end of it: a real tap comes later than that.
      await page.waitForTimeout(450);
      await page.mouse.click(spot.x, spot.y);
      await expect(mapNamed(page, MAP)).toBeVisible();
      await expect(page.getByTestId('map-title')).toHaveText(MAP);
    });

    test('a tap on a region’s land opens that region, a tap on the sea or land not reached opens the planet’s map', async ({
      page,
    }) => {
      test.setTimeout(240_000);
      await toGround(page, size, []);
      await page.waitForTimeout(1200);
      // The camera has come down over CI region 4: the pale land round the ship is its own, never a name's button.
      const land = LAND_ON_GROUND[size.label];
      expect(await ownedByGroundPress(page, land)).toBe(true);
      await shot(page, `regions-1-ground-before-tap-${size.label}`);
      await page.mouse.click(land.x, land.y);
      await expect(mapNamed(page, 'CI region 4, a region of CI planet 2')).toBeVisible();
      await expect(mapNamed(page, MAP)).toHaveCount(0);
      await expectNothingClosed(page);
      await page.getByRole('button', { name: 'Back to CI planet 2' }).click();
      await expect(screenOf(page)).toHaveCount(0);
      await landed(page);

      // The sea answers no region, so it is bare ground: the planet's own map.
      const sea = SEA_ON_GROUND[size.label];
      expect(await ownedByGroundPress(page, sea)).toBe(true);
      await page.mouse.click(sea.x, sea.y);
      await expect(mapNamed(page, MAP)).toBeVisible();
    });

    test('Escape and the browser’s Back each go one step, and agree with the header’s Back', async ({ page }) => {
      test.setTimeout(240_000);
      await toGround(page, size, []);
      for (const leave of ['Escape', 'goBack'] as const) {
        await chip(page).click();
        await region(page, 6).click();
        await expect(mapNamed(page, 'CI region 6, a region of CI planet 2')).toBeVisible();
        if (leave === 'Escape') await page.keyboard.press('Escape');
        else await page.goBack();
        await expect(mapNamed(page, MAP)).toBeVisible();
        if (leave === 'Escape') await page.keyboard.press('Escape');
        else await page.goBack();
        await expect(screenOf(page)).toHaveCount(0);
        await expect(chip(page)).toBeFocused();
        await landed(page);
      }
      // The page is still the Universe: the browser's Back did not take the person past it.
      await expect(page).toHaveURL(/\/universe/);
      await expect(chip(page)).toBeVisible();
    });
  });
}

test('Search opened over a map returns to it, and the stage is reachable only while Search is open', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await toGround(page, SIZES[0], []);
  await openMapByChip(page);
  // `/` is a key of the whole page, so Search really does open over a map.
  await page.keyboard.press('/');
  await expect(page.getByTestId('universe-search-panel')).toBeVisible();
  await expect(screenOf(page)).toHaveCount(0);
  await expect(page.getByTestId('universe-map')).not.toHaveAttribute('inert', '');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('universe-search-panel')).toHaveCount(0);
  await expect(mapNamed(page, MAP)).toBeVisible();
  await expect(page.getByTestId('universe-map')).toHaveAttribute('inert', '');
  await page.keyboard.press('Escape');
  await expect(screenOf(page)).toHaveCount(0);
  await expect(chip(page)).toBeFocused();
});

/**
 * What a map paints: the colour of each visible piece of text, each background that is not transparent, each border
 * that has a width, and each SVG shape's fill and stroke. The Universe is pinned to its authored palette (D-400).
 */
const mapColours = (page: Page): Promise<string[]> =>
  screenOf(page).evaluate((screen) => {
    const painted: string[] = [];
    for (const element of screen.querySelectorAll<HTMLElement | SVGElement>('*')) {
      if (!element.checkVisibility() || element.getBoundingClientRect().width === 0) continue;
      // The "you were here" ripple and anything else that moves is not a colour of the screen.
      const style = getComputedStyle(element);
      const name = element.tagName.toLowerCase();
      const ownText = [...element.childNodes].some((node) => node.nodeType === 3 && (node.textContent ?? '').trim());
      // An SVG text is painted by its fill (reported below); the `color` it inherits is not painted.
      if (ownText && !(element instanceof SVGElement))
        painted.push(`${name} "${(element.textContent ?? '').trim().slice(0, 24)}" text ${style.color}`);
      if (style.backgroundColor !== 'rgba(0, 0, 0, 0)') painted.push(`${name} background ${style.backgroundColor}`);
      if (parseFloat(style.borderTopWidth) > 0) painted.push(`${name} border ${style.borderTopColor}`);
      if (element instanceof SVGElement && name !== 'svg')
        painted.push(`${name} fill ${style.fill} stroke ${style.stroke}`);
    }
    return painted;
  });

test('both maps look the same in Light and in Dark (D-400)', async ({ browser }) => {
  test.setTimeout(240_000);
  const seen: Record<string, string[][]> = {};
  for (const appearance of ['light', 'dark'] as const) {
    const page = await browser.newPage();
    await toGround(page, SIZES[0], [], { appearance });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-ks-appearance')))
      .toBe(appearance);
    await chip(page).click();
    await expect(mapNamed(page, MAP)).toBeVisible();
    const first = await mapColours(page);
    await region(page, 4).click();
    await expect(mapNamed(page, 'CI region 4, a region of CI planet 2')).toBeVisible();
    await expect(page.getByTestId('map-contents')).toBeVisible();
    await page.waitForTimeout(500);
    const second = await mapColours(page);
    await shot(page, `maps-7-region-${appearance}`);
    seen[appearance] = [first, second];
    await page.close();
  }
  // Something was read on each screen, so the comparison compares the screens and not two empty lists.
  for (const colours of seen['light'] ?? []) expect(colours.length).toBeGreaterThan(5);
  expect(seen['light']).toEqual(seen['dark']);
});

test('with the switch off there is no chip, no press layer and no map', async ({ page }) => {
  test.setTimeout(180_000);
  await openVoyage(page, [], { trial: false, calm: true });
  await expect(page.getByRole('button', { name: 'CI system 0, a system', exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId('voyage-stage')).toHaveCount(0);
  await expect(page.getByTestId('universe-map-open')).toHaveCount(0);
  await expect(page.getByTestId('voyage-ground-press')).toHaveCount(0);
  await expect(page.getByTestId('map-screen')).toHaveCount(0);
  await expect(page.getByText(/^Map of /)).toHaveCount(0);
});
