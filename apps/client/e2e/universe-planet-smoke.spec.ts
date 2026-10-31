import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { fixtureAccount, sceneFixture } from '../features/universe/universe.fixture';
import { emptyInbox, isInboxPath } from './empty-inbox';
import { tapOrbitingTarget } from './orbiting-target';

/**
 * The planet globe (U03) and the landed map (U04) in the production export, over authored HTTP
 * fixtures: a planet with four regions. The checks are the ones the slice promises: browsing writes
 * nothing, land that is not reached yet is not in the accessibility tree, and axe finds nothing
 * serious at a phone and a desktop width. Set `KS_SHOT_DIR` to also save screenshots.
 */
const shots = process.env['KS_SHOT_DIR'];

const reads = new Set([
  '/v1/universe/geography/read',
  '/v1/universe/geography/deltas/read',
  '/v1/universe/scenes/manifest/read',
  '/v1/universe/scenes/chunks/read',
  '/v1/universe/emerging/read',
  '/v1/experience/region/preview',
  '/v1/universe/formation/read',
]);

async function openPlanet(page: Page, size: { width: number; height: number }) {
  const world = sceneFixture(5, 0, 3);
  // Local only: look at the same planet as another type (KS_PLANET_TYPE=lush) when comparing with the design.
  const type = process.env['KS_PLANET_TYPE'];
  for (const look of world.looks)
    if (type && look.kind === 'planet')
      Object.assign(look, { type, rings: process.env['KS_RINGS'] === '1', moon: process.env['KS_MOON'] === '1' });
  const calls: { method: string; path: string }[] = [];
  await page.setViewportSize(size);
  await page.route('**/auth/session', (route) =>
    route.fulfill({ json: { account: fixtureAccount, client: 'web', expiresAt: '2099-10-21T00:00:00.000Z' } }),
  );
  await page.route('**/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    const scope = { universeId: fixtureAccount.universeId, privacyEpoch: 1, personalWatermark: 40 };
    if (path === '/v1/privacy/recording/read')
      return route.fulfill({
        json: {
          ...body,
          scope: { accountId: fixtureAccount.accountId, privacyEpoch: 1 },
          revision: 0,
          policy: { on: true, generation: 1 },
        },
      });
    if (isInboxPath(path)) return route.fulfill({ json: emptyInbox(path, body, fixtureAccount.accountId) });
    calls.push({ method: route.request().method(), path });
    if (path.endsWith('/formation/read'))
      return route.fulfill({
        json: {
          ...body,
          scope,
          recordedAt: '2026-10-22T00:00:00.000Z',
          currentGeography: { revision: 3, structureRevision: 3, activityRevision: 0 },
          sceneRevision: 7,
          status: 'none',
        },
      });
    if (path.endsWith('/region/preview'))
      return route.fulfill({
        json: {
          ...body,
          scope,
          recordedAt: '2026-10-22T00:00:00.000Z',
          geographyRevision: 3,
          status: 'available',
          encounter: {
            assetId: '0199a000-0000-7000-8000-000000000500',
            assetRevision: 1,
            metadata: {
              kind: 'reel',
              title: 'CI card title',
              summary: 'Authored fixture text, not generated content.',
              language: 'en',
            },
          },
        },
      });
    if (path.startsWith('/v1/universe/')) return route.fulfill({ json: world.reply(path, body) });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto('/universe');
  await page.getByRole('button', { name: 'CI system 0, a system', exact: true }).click();
  // From 1024 px a tap on a planet picks it for the panel's card; its row in the panel opens its globe.
  const planet = page.getByRole('button', {
    name: size.width >= 1024 ? 'CI planet 2, a planet in CI system 0' : 'CI planet 2, a planet',
    exact: true,
  });
  if (size.width >= 1024) await planet.click();
  else await tapOrbitingTarget(planet);
  await expect(page.getByRole('heading', { level: 1, name: 'CI planet 2', exact: true })).toBeVisible();
  return calls;
}

async function shot(page: Page, name: string) {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
}

async function expectNoSeriousViolations(page: Page) {
  if (process.env['KS_SKIP_AXE']) return;
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => ({ rule: v.id, nodes: v.nodes.map((node) => node.target.join(' ')) }))).toEqual([]);
}

test('a long system name shortens inside the Back pill on a phone, and the pill keeps its whole name for a screen reader', async ({
  page,
}) => {
  await openPlanet(page, { width: 390, height: 844 });
  const back = page.getByTestId('universe-up');
  const name = 'Physical processes of Earth and its astronomical setting and everything that follows from it';
  // The text is swapped in the page: the fixture's own names are short.
  await back.evaluate((node, text) => {
    const leaf = [...node.querySelectorAll('div')].find((div) => div.children.length === 0 && div.textContent !== '');
    if (leaf === undefined) throw new Error('the pill has a label');
    leaf.textContent = text;
  }, name);
  const box = (await back.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await expect(back).toHaveAttribute('aria-label', /^Back to /);
});

for (const size of [
  { width: 390, height: 844, label: 'phone' },
  { width: 1440, height: 900, label: 'desktop' },
]) {
  test(`the globe, the landed map and a region card at ${size.label}: browsing writes nothing, grey land is not announced, axe is clean`, async ({
    page,
  }) => {
    const calls = await openPlanet(page, size);
    // U03: a turning globe, a hint and one way to land. Names of regions are drawing, not controls.
    await expect(page.getByText('Drag to rotate · tap to land', { exact: true })).toBeVisible();
    const land = page.getByRole('button', { name: 'Land on CI planet 2', exact: true });
    await expect(land).toBeVisible();
    await page.waitForTimeout(600);
    await shot(page, `u03-globe-${size.label}`);
    await expectNoSeriousViolations(page);
    // Dragging turns the globe and nothing else.
    const box = (await land.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    // The pointer is let go over the globe, and the browser sends a click: a drag is not a tap.
    await expect(land).toBeVisible();
    await expect(page.getByTestId('universe-level')).toHaveCount(0);
    await shot(page, `u03-after-drag-${size.label}`);
    // The same for a drag up or down, and for one that goes both ways: the camera moves in y as well as x.
    for (const [across, down] of [
      [0, 80],
      [0, -80],
      [60, 60],
    ] as const) {
      await page.waitForTimeout(500);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + across, box.y + box.height / 2 + down, { steps: 8 });
      await page.mouse.up();
      await expect(land).toBeVisible();
      await expect(page.getByTestId('universe-level')).toHaveCount(0);
    }
    await page.waitForTimeout(500);
    // Tapping lands on the map at planet level, nothing chosen.
    await land.click();
    await expect(page.getByTestId('universe-level')).toHaveText('PLANET');
    const targets = page.locator('[data-testid^="universe-focus-"]');
    await expect(targets).toHaveCount(4);
    expect(await targets.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')))).toEqual([
      'CI region 4, a region',
      'CI region 5, a region',
      'CI region 6, a region',
      'CI region 7, a region',
    ]);
    await page.waitForTimeout(600);
    await shot(page, `u04-map-${size.label}`);
    // The map opens on the formed regions: every one is inside the screen, and so is the whole Back pill (#548).
    const inside = (box: { x: number; y: number; width: number; height: number } | null) => {
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(size.width);
      expect(box!.y + box!.height).toBeLessThanOrEqual(size.height);
    };
    for (const target of await targets.all()) inside(await target.boundingBox());
    inside(await page.getByTestId('universe-up').boundingBox());
    if (size.label === 'desktop') {
      // The key hints do not sit under the chips at the bottom left.
      const hints = await page.getByText('Back up a level').boundingBox();
      const chips = await page.getByTestId('universe-up').boundingBox();
      expect(hints).not.toBeNull();
      expect(chips).not.toBeNull();
      for (const chip of await page.getByRole('button', { name: /^Route to / }).all()) {
        const chipBox = (await chip.boundingBox())!;
        const clear = hints!.x >= chipBox.x + chipBox.width || chipBox.y >= hints!.y + hints!.height;
        expect(clear).toBe(true);
      }
    }
    // Grey land has no text, no control and no node in the accessibility tree.
    const tree = await page.locator('body').ariaSnapshot();
    expect(tree).not.toMatch(/uncharted|not reached|unreached|locked|grey|gray/i);
    // Only the four formed regions are named anywhere in it.
    expect([...new Set(tree.match(/CI region \d+/g))].sort()).toEqual([
      'CI region 4',
      'CI region 5',
      'CI region 6',
      'CI region 7',
    ]);
    await expectNoSeriousViolations(page);
    // Choosing a region drops the camera, dims the rest and opens its card, a read of the server and nothing more.
    await page.getByRole('button', { name: 'CI region 5, a region', exact: true }).click();
    await expect(page.getByTestId('universe-region-card')).toBeVisible();
    await expect(page.getByTestId('universe-level')).toHaveText('REGION');
    await page.waitForTimeout(400);
    await shot(page, `u04-card-${size.label}`);
    await expectNoSeriousViolations(page);
    // Back out through the map to the globe's system, keeping the person's place private.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('universe-region-card')).toHaveCount(0);
    expect(calls.every((call) => call.method === 'POST' && reads.has(call.path))).toBe(true);
    expect(calls.filter((call) => /open|activate|observations|actions/.test(call.path))).toEqual([]);
  });
}

test('the region left through its card is marked "you were here" on the map, and the marker is private to the device', async ({
  page,
}) => {
  const calls = await openPlanet(page, { width: 390, height: 844 });
  await page.getByRole('button', { name: 'Land on CI planet 2', exact: true }).click();
  await expect(page.getByTestId('universe-level')).toHaveText('PLANET');
  // What Open leaves behind when the person comes back (universe-here-marker.ts), written as the app writes it.
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((name) => name.endsWith('universe.view.v1'))!;
    const prefix = key.slice(0, key.length - 'universe.view.v1'.length);
    localStorage.setItem(
      `${prefix}universe.here.v1`,
      JSON.stringify({ placeId: '0199a000-0000-7000-8000-000000000064', at: Date.now() }),
    );
  });
  await page.reload();
  const here = page.getByRole('button', { name: 'CI region 5 · you were here, a region', exact: true });
  await expect(here).toBeVisible();
  await expect(page.getByTestId('universe-level')).toHaveText('PLANET');
  await page.waitForTimeout(600);
  await shot(page, 'u04-here-phone');
  await expectNoSeriousViolations(page);
  // Choosing it again clears the marker.
  await here.click();
  await expect(page.getByRole('button', { name: 'CI region 5, a region', exact: true })).toBeVisible();
  expect(calls.every((call) => call.method === 'POST' && reads.has(call.path))).toBe(true);
});
