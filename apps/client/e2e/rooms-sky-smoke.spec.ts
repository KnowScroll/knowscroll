import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { fixtureAccount, fixtureId, sceneFixture } from '../features/universe/universe.fixture';
import { id } from './encounter-fixture';
import { emptyInbox, isInboxPath } from './empty-inbox';
import { FACES, room, roomFixture } from './rooms-fixture';
import { TODAY_STRIP, skyOf, skyRoutes, skyWorld, type SkyWorld } from './rooms-sky-fixture';

/**
 * Today and the sky (v3 R-5) in the production export over labelled HTTP fixtures, for two people who share one room. Person A
 * answers Today's Spot the flaw and sees the room earn a star, then names the constellation the star finished; person C only
 * opens their Universe and finds the same sky around the room's station. Axe covers names, roles and contrast at 390 and
 * 1440. With `KS_ROOM_SHOTS` set to a folder, each step also saves a screenshot there (never inside the repository).
 */
const shotsFolder = process.env['KS_ROOM_SHOTS'];
async function shoot(page: Page, name: string) {
  if (shotsFolder === undefined) return;
  mkdirSync(shotsFolder, { recursive: true });
  await page.screenshot({ path: join(shotsFolder, `${name}.png`) });
}

async function seriousViolations(page: Page, within?: string) {
  const builder = new AxeBuilder({ page });
  if (within !== undefined) builder.include(within);
  const results = await builder
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({
      rule: violation.id,
      targets: violation.nodes.slice(0, 4).map((node) => `${node.target.join(' ')}  ${node.html.slice(0, 100)}`),
    }));
}

const VIEWPORTS = [
  { name: 'phone', size: { width: 390, height: 844 } },
  { name: 'desktop', size: { width: 1440, height: 900 } },
] as const;
const scope = { accountId: id(1), privacyEpoch: 1 };

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

/** Person C's Universe: a map with the Space room's station beside the first system, and an outsider's station beside it. */
async function openMapOfC(page: Page, world: SkyWorld, size: { width: number; height: number }) {
  const map = sceneFixture(5, 0);
  const kit = FACES.space.kit;
  const place = { systemId: fixtureId(10) };
  map.stations.push(
    {
      room: { ...room, identity: { kit } },
      standing: 'member',
      placement: place,
      // A getter, so the read says what the room has earned at the moment it is read.
      get sky() {
        return skyOf(world);
      },
    } as never,
    {
      room: {
        ...room,
        roomId: '0199a000-0000-7000-8000-a5a5a5a50001',
        name: 'Outside room',
        identity: { kit: FACES.history.kit },
      },
      standing: 'none',
      placement: place,
    } as never,
  );
  await page.setViewportSize(size);
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
    if (path === '/v1/rooms/stations') return route.fulfill({ json: map.reply(path, body) });
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
    return route.fulfill({ json: map.reply(path, body) });
  });
  await page.goto('/universe');
}

for (const { name, size } of VIEWPORTS) {
  test(`${name}: A answers Today, the room earns a star and names its constellation, and C's map shows the same sky`, async ({
    page,
    browser,
  }) => {
    // The room has six stars; the seventh finishes a constellation.
    const world = skyWorld(6);
    const { address } = await roomFixture(page, size, {
      others: 1,
      lastMessageMinutesAgo: 5,
      noticeSeen: true,
      sky: () => skyOf(world),
      today: TODAY_STRIP,
    });
    const { calls } = await skyRoutes(page, world, scope);

    // The Now strip: Today with its question, and the sky. No number says how many people are here or active.
    await page.goto(address);
    await expect(page.getByTestId('now-strip')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Today, Why is the night sky dark?' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Room sky, 6 of 7 stars' })).toBeVisible();
    await expect(page.getByText(/online/i)).toHaveCount(0);
    await shoot(page, `${name}-room-now-strip`);
    expect(await seriousViolations(page)).toEqual([]);

    // Today: the labelled residents ask, a sentence is tapped once, and the key arrives only after the tap.
    await page.getByTestId('now-today').click();
    await expect(page).toHaveURL(/\/today$/);
    await expect(page.getByTestId('today-question')).toContainText('Why is the night sky dark?');
    await expect(page.getByTestId('today-question')).toContainText('Nova');
    await expect(page.getByTestId('today-question')).toContainText('AI · Explainer');
    await expect(page.getByTestId('today-flaw')).toContainText('Halley');
    await expect(page.getByTestId('today-flaw')).toContainText('AI · Skeptic');
    await expect(page.getByTestId('flaw-reveal')).toHaveCount(0);
    await expect(page.getByText('ALTERED')).toHaveCount(0);
    await expect(page.getByText('Because the universe has a beginning')).toBeVisible();
    await shoot(page, `${name}-today-open`);
    expect(await seriousViolations(page)).toEqual([]);

    await page.getByTestId('flaw-sentence-2').click();
    await expect(page.getByText('Found it!')).toBeVisible();
    await expect(page.getByText('ALTERED')).toBeVisible();
    await expect(page.getByTestId('flaw-star')).toHaveText('+1 star for the room');
    await expect(page.getByText('1 found it')).toBeVisible();
    await expect(page.getByTestId('flaw-sentence-0')).toBeDisabled();
    expect(calls.filter((call) => call.path === '/v1/rooms/today/solve')).toHaveLength(1);
    expect(calls.find((call) => call.path === '/v1/rooms/today/solve')?.body).toMatchObject({ sentence: 2 });
    await shoot(page, `${name}-today-solved`);
    expect(await seriousViolations(page)).toEqual([]);

    // The star finished the constellation: the room's sky says so and offers three names.
    await page.goBack();
    await expect(page.getByRole('button', { name: 'Room sky, 7 of 7 stars' })).toBeVisible();
    await page.getByTestId('now-sky').click();
    await expect(page.getByTestId('sky-line')).toHaveText('7 of 7 stars');
    await expect(page.getByTestId('constellation').getByRole('button')).toHaveCount(7);
    await page.getByRole('button', { name: 'Star 1 of 7' }).click();
    await expect(page.getByTestId('sky-moment')).toContainText('An answer someone found useful');
    await expect(page.getByText('Name this constellation')).toBeVisible();
    await expect(page.getByText(/\d votes?$/)).toHaveCount(0);
    await shoot(page, `${name}-sky-naming`);
    expect(await seriousViolations(page)).toEqual([]);
    await page.getByTestId('sky-name-1').click();
    await expect(page.getByLabel('The Kite, 1 vote')).toBeVisible();
    expect(calls.find((call) => call.path === '/v1/rooms/sky/name')?.body).toMatchObject({ candidate: 1 });

    // Person C, in another browser with another account, opens their Universe: the room's station carries the same sky.
    const other = await browser.newContext();
    const mapPage = await other.newPage();
    await mapPage.emulateMedia({ reducedMotion: 'reduce' });
    await openMapOfC(mapPage, world, size);
    await expect(
      mapPage.getByRole('button', { name: 'Space room, a room station, 7 of 7 · Lit' }).first(),
    ).toBeVisible();
    // A station of a room C is not in is drawn exactly as before: its name and nothing about its sky.
    // At desktop width the panel lists the same stations, so a station may have two buttons: the first is enough.
    await expect(
      mapPage.getByRole('button', { name: 'Outside room, a room station', exact: true }).first(),
    ).toBeVisible();
    await expect(mapPage.getByText(/Outside room · /)).toHaveCount(0);
    await shoot(mapPage, `${name}-c-map`);
    expect(await seriousViolations(mapPage)).toEqual([]);
    await other.close();
  });
}
