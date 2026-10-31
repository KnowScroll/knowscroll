import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { fixtureAccount, fixtureId, sceneFixture } from '../features/universe/universe.fixture';
import { emptyInbox, isInboxPath } from './empty-inbox';
import { tapOrbitingTarget } from './orbiting-target';

/**
 * The person's collection on the Universe in the production export (v3 S-4, D-084, D-087, D-089, D-215): a
 * landmark that waits in the tray until its planet has formed and then stands on it, the Orbit as text, the
 * resume chip, at a phone and a desktop width, with reduced motion and axe. Authored HTTP fixtures: no landmark
 * here was earned by anyone. Set `KS_SHOT_DIR` to also save screenshots.
 */
const shots = process.env['KS_SHOT_DIR'];

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

async function openUniverse(
  page: Page,
  size: { width: number; height: number },
  options: { formed: boolean; reducedMotion?: boolean },
) {
  const world = sceneFixture(5, 1, 3);
  world.collection.landmarks = [
    landmark(),
    landmark({ key: 'the-turning-halves', name: 'The Turning Halves', tier: 'plain', assetId: fixtureId(501) }),
  ];
  world.collection.orbit = { days: 1, goal: 3, weekStart: '2026-11-02', closed: false };
  world.collection.resume = { assetId: fixtureId(502), title: 'Why the hemispheres take turns', part: 2, total: 3 };
  world.collection.planets = options.formed ? [{ id: fixtureId(12), topicId: 'earth.seasons' }] : [];
  const calls: { method: string; path: string }[] = [];
  await page.emulateMedia({ reducedMotion: options.reducedMotion ? 'reduce' : 'no-preference' });
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
    if (path.startsWith('/v1/universe/') || path.startsWith('/v1/play/') || path === '/v1/experience/resume/read')
      return route.fulfill({ json: world.reply(path, body) });
    if (path === '/v1/rooms/stations') return route.fulfill({ json: world.reply(path, body) });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto('/universe');
  await expect(page.getByRole('button', { name: 'CI system 0, a system', exact: true })).toBeVisible();
  return { world, calls };
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

test.describe('a phone, 390 x 844', () => {
  const size = { width: 390, height: 844 };

  test('a landmark waits in the tray while its planet is not formed, with the Orbit in words and the resume chip', async ({
    page,
  }) => {
    const { calls } = await openUniverse(page, size, { formed: false });
    await expect(page.getByTestId('universe-landmark-tray')).toBeVisible();
    await expect(page.getByTestId('universe-landmark-tray')).toContainText('Your landmarks are waiting');
    await expect(page.getByTestId('universe-orbit')).toHaveText('Orbit · 1 of 3 days this week');
    await expect(page.getByTestId('universe-resume')).toHaveText('Resume Part 2 of 3');
    await expect(
      page.getByRole('button', { name: 'Resume Part 2 of 3: Why the hemispheres take turns' }),
    ).toBeVisible();
    await shot(page, 'collection-phone-tray');
    await page.getByRole('button', { name: 'See it' }).click();
    const sheet = page.getByTestId('universe-collection-sheet');
    await expect(sheet).toContainText('Gold finish · Waiting for its planet');
    await expect(sheet).toContainText('Plain finish · Waiting for its planet');
    await expect(sheet).toContainText('Missed a week? Nothing here goes away. Orbits just start fresh on Monday.');
    await shot(page, 'collection-phone-sheet');
    await expectNoSeriousViolations(page);
    // Escape closes the sheet, as it closes every other card.
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    // Reading the collection only reads.
    expect(
      calls.filter((call) => call.method !== 'POST' || /activate|observations|actions|lock/.test(call.path)),
    ).toEqual([]);
  });

  test('the landmark stands on its planet once that planet has formed, painted on the globe and listed in words', async ({
    page,
  }) => {
    await openUniverse(page, size, { formed: true });
    await expect(page.getByTestId('universe-landmark-tray')).toHaveCount(0);
    await page.getByRole('button', { name: 'CI system 0, a system', exact: true }).click();
    await tapOrbitingTarget(page.getByRole('button', { name: 'CI planet 2, a planet', exact: true }));
    await expect(page.getByRole('heading', { level: 1, name: 'CI planet 2', exact: true })).toBeVisible();
    // The pennants are painted on the globe: a gold one and a cream one.
    await expect(page.locator('[data-testid="landmark-mark-gold"]').first()).toBeAttached();
    await expect(page.locator('[data-testid="landmark-mark-plain"]').first()).toBeAttached();
    await shot(page, 'collection-phone-globe');
    await page.getByRole('button', { name: 'Landmarks · 2' }).click();
    await expect(page.getByTestId('universe-collection-sheet')).toContainText('Gold finish · On CI planet 2');
    await expectNoSeriousViolations(page);
  });

  test('with reduced motion the landed states are drawn at once and nothing moves', async ({ page }) => {
    await openUniverse(page, size, { formed: true, reducedMotion: true });
    await expect(page.getByTestId('universe-landmarks')).toBeVisible();
    await page.getByRole('button', { name: 'CI system 0, a system', exact: true }).click();
    await tapOrbitingTarget(page.getByRole('button', { name: 'CI planet 2, a planet', exact: true }));
    await page.getByRole('button', { name: 'Land on CI planet 2' }).click();
    await expect(page.locator('[data-testid="landmark-mark-gold"]').first()).toBeAttached();
    await shot(page, 'collection-phone-map');
    // The markers are drawn on the landed map; none of them animates.
    const animations = await page.evaluate(
      () => document.getAnimations().filter((animation) => animation.playState === 'running').length,
    );
    expect(animations).toBe(0);
    await expectNoSeriousViolations(page);
  });

  test('the resume chip opens the next Part by its address', async ({ page }) => {
    await openUniverse(page, size, { formed: false });
    await page.getByTestId('universe-resume').click();
    await expect(page).toHaveURL(new RegExp(`/scroll/${fixtureId(502)}`));
  });
});

test.describe('a desktop, 1440 x 900', () => {
  const size = { width: 1440, height: 900 };

  test('the panel carries the Orbit, the resume button and the landmark list; the tray waits on the map', async ({
    page,
  }) => {
    await openUniverse(page, size, { formed: false });
    const panel = page.getByTestId('universe-panel');
    const section = panel.getByTestId('universe-collection-section');
    await expect(section).toContainText('Orbit · 1 of 3 days this week');
    await expect(section).toContainText('The Leaning Axis');
    await expect(section).toContainText('Gold finish · Waiting for its planet');
    await expect(
      section.getByRole('button', { name: 'Resume Part 2 of 3: Why the hemispheres take turns' }),
    ).toBeVisible();
    await expect(page.getByTestId('universe-landmark-tray')).toBeVisible();
    await shot(page, 'collection-desktop-panel');
    await expectNoSeriousViolations(page);
  });

  test('a landmark whose planet has formed is listed on that planet, and the panel row flies to it', async ({
    page,
  }) => {
    await openUniverse(page, size, { formed: true });
    const section = page.getByTestId('universe-panel').getByTestId('universe-collection-section');
    await expect(section).toContainText('Gold finish · On CI planet 2');
    await expect(page.getByTestId('universe-landmark-tray')).toHaveCount(0);
    await section.getByRole('button', { name: 'The Leaning Axis, Gold finish, on CI planet 2' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'CI planet 2', exact: true })).toBeVisible();
    await shot(page, 'collection-desktop-planet');
    await expectNoSeriousViolations(page);
  });
});
