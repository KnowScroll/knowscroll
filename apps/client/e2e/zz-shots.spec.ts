import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { COLLECTION_READS, fixtureAccount, fixtureId, sceneFixture } from '../features/universe/universe.fixture';
import { emptyInbox, isInboxPath } from './empty-inbox';
import { tapOrbitingTarget } from './orbiting-target';

// Local screenshots for the fidelity fixes (never committed).
const folder = process.env['KS_SHOT_DIR'] ?? 'C:/Users/XZNON/knowscroll-dev/tmp/fix-universe/shots';
mkdirSync(folder, { recursive: true });
const landmark = (over: Record<string, unknown> = {}) => ({
  key: 'the-leaning-axis',
  name: 'The Leaning Axis',
  tier: 'gold',
  assetId: fixtureId(500),
  revision: 1,
  earnedAt: '2026-11-02T10:00:00.000Z',
  topicId: 'earth.seasons',
  ...over,
});

interface Options {
  size: { width: number; height: number };
  formed?: boolean;
  calm?: boolean;
  dust?: number;
  noSystems?: boolean;
  formation?: 'none' | 'unavailable';
  offline?: boolean;
  landmarks?: boolean;
}

async function open(page: Page, o: Options) {
  const world = sceneFixture(o.noSystems ? 0 : 5, o.dust ?? 0, 3);
  if (o.landmarks !== false) {
    world.collection.landmarks = [
      landmark(),
      landmark({ key: 'the-turning-halves', name: 'The Turning Halves', tier: 'plain', assetId: fixtureId(501) }),
    ];
    world.collection.orbit = { days: 1, goal: 3, weekStart: '2026-11-02', closed: false };
    world.collection.resume = { assetId: fixtureId(502), title: 'Why the hemispheres take turns', part: 2, total: 3 };
  }
  world.collection.planets = o.formed ? [{ id: fixtureId(12), topicId: 'earth.seasons' }] : [];
  await page.setViewportSize(o.size);
  if (o.calm) await page.emulateMedia({ reducedMotion: 'reduce' });
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
    if (o.offline && path.startsWith('/v1/universe/')) return route.abort('connectionfailed');
    if (path.endsWith('/formation/read'))
      return route.fulfill({
        json: {
          ...body,
          scope,
          recordedAt: '2026-10-22T00:00:00.000Z',
          currentGeography: { revision: 3, structureRevision: 3, activityRevision: 0 },
          sceneRevision: 7,
          ...(o.formation === 'unavailable'
            ? { status: 'unavailable', reason: 'temporarily_unavailable' }
            : { status: 'none' }),
        },
      });
    if (path.startsWith('/v1/universe/') || path.startsWith('/v1/play/') || path === '/v1/experience/resume/read')
      return route.fulfill({ json: world.reply(path, body) });
    if (path === '/v1/rooms/stations') return route.fulfill({ json: world.reply(path, body) });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto('/universe');
}

const shot = async (page: Page, name: string, size: Options['size']) => {
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(folder, `${name}-${String(size.width)}.png`) });
};

const sizes = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
];

for (const size of sizes) {
  const root = page_ => page_.getByRole('button', { name: 'CI system 0, a system', exact: true });
  test(`overview ${String(size.width)}`, async ({ page }) => {
    await open(page, { size, formed: true, calm: true });
    await expect(root(page)).toBeVisible({ timeout: 60_000 });
    await shot(page, 'overview', size);
  });
  test(`offline ${String(size.width)}`, async ({ page }) => {
    await open(page, { size, offline: true, calm: true });
    await expect(page.getByText('You’re offline')).toBeVisible({ timeout: 60_000 });
    await shot(page, 'offline', size);
  });
  test(`notice ${String(size.width)}`, async ({ page }) => {
    await open(page, { size, formed: false, calm: true, formation: 'unavailable' });
    await expect(page.getByTestId('formation-notice')).toBeVisible({ timeout: 60_000 });
    await shot(page, 'notice', size);
  });
  test(`system ${String(size.width)}`, async ({ page }) => {
    await open(page, { size, formed: true, calm: true });
    await root(page).click({ timeout: 60_000 });
    await expect(page.getByRole('heading', { level: 1, name: 'CI system 0', exact: true })).toBeVisible();
    await shot(page, 'system', size);
  });
  test(`planet ${String(size.width)}`, async ({ page }) => {
    await open(page, { size, formed: true, calm: true });
    await root(page).click({ timeout: 60_000 });
    await tapOrbitingTarget(page.getByRole('button', { name: 'CI planet 2, a planet', exact: true }));
    await expect(page.getByRole('heading', { level: 1, name: 'CI planet 2', exact: true })).toBeVisible();
    await shot(page, 'planet', size);
  });
  test(`search ${String(size.width)}`, async ({ page }) => {
    await open(page, { size, formed: true, calm: true });
    await expect(root(page)).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Search your universe', exact: true }).first().click();
    await shot(page, 'search', size);
  });
  test(`emerging ${String(size.width)}`, async ({ page }) => {
    await open(page, { size, noSystems: true, dust: 1, calm: true, landmarks: false });
    await page.waitForTimeout(4000);
    await shot(page, 'emerging', size);
  });
  test(`simple ${String(size.width)}`, async ({ page }) => {
    await open(page, { size, formed: true, calm: true });
    await expect(root(page)).toBeVisible({ timeout: 60_000 });
    if (size.width < 1000) {
      await page.getByRole('button', { name: 'List view', exact: true }).click();
      await page.getByRole('togglebutton', { name: 'Simple view' }).click();
    } else await page.getByRole('switch', { name: 'Simple drawing' }).click();
    await expect(page.getByTestId('universe-simple')).toBeVisible();
    await shot(page, 'simple', size);
  });
}

test('dial 390', async ({ page }) => {
  const size = sizes[0]!;
  await open(page, { size, formed: true, calm: true });
  await page.getByRole('button', { name: 'List view', exact: true }).click({ timeout: 60_000 });
  await shot(page, 'dial-rest', size);
  await page.getByTestId('dial-system-pill').click();
  await shot(page, 'dial-wheel', size);
  await page.getByRole('button', { name: 'Filter systems' }).click();
  await shot(page, 'dial-filters', size);
  await page.getByTestId('dial-search').click();
  await page.getByRole('searchbox').fill('ci');
  await shot(page, 'dial-search', size);
});

test('dial planet search 390', async ({ page }) => {
  const size = sizes[0]!;
  await open(page, { size, formed: true, calm: true });
  await page.getByRole('button', { name: 'List view', exact: true }).click({ timeout: 60_000 });
  await page.getByTestId('dial-search').click();
  await page.getByRole('searchbox').fill('planet');
  await shot(page, 'dial-planet-search', size);
});

test('landed region pill 1440', async ({ page }) => {
  const size = sizes[1]!;
  await open(page, { size, formed: true, calm: true });
  await root1(page).click({ timeout: 60_000 });
  await page.getByRole('button', { name: 'CI planet 2, a planet', exact: true }).first().click();
  await page.getByRole('button', { name: /Land on CI planet 2/ }).click();
  await page.waitForTimeout(1500);
  await shot(page, 'landed', size);
});

const root1 = (p: Page) => p.getByRole('button', { name: 'CI system 0, a system', exact: true });
