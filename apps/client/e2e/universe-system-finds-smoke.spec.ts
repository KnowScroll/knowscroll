import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { fixtureAccount, fixtureId, sceneFixture } from '../features/universe/universe.fixture';
import { emptyInbox, isInboxPath } from './empty-inbox';

/**
 * A system's Reels and Scrolls in the production export (#697, D-403): "Watch or read" in a system's view, on a system
 * with no planet yet as well, at a phone and a desktop width, with axe. Authored HTTP fixtures: no title here names real
 * content. Set `KS_SHOT_DIR` to also save screenshots.
 */
const shots = process.env['KS_SHOT_DIR'];

async function openUniverse(page: Page, size: { width: number; height: number }, objects: number) {
  const world = sceneFixture(objects);
  world.systemFinds.finds = [
    { assetId: fixtureId(600), assetRevision: 1, kind: 'reel', title: 'How attention picks its words' },
    { assetId: fixtureId(601), assetRevision: 1, kind: 'scroll', title: 'Why transformers read in parallel' },
    { assetId: fixtureId(602), assetRevision: 1, kind: 'scroll', title: 'What a loss curve is telling you' },
  ];
  const calls: { method: string; path: string }[] = [];
  await page.setViewportSize(size);
  await page.emulateMedia({ reducedMotion: 'reduce' });
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
    if (
      path.startsWith('/v1/universe/') ||
      path.startsWith('/v1/play/') ||
      path === '/v1/experience/resume/read' ||
      path === '/v1/rooms/stations'
    )
      return route.fulfill({ json: world.reply(path, body) });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto('/universe');
  await expect(page.getByRole('button', { name: 'CI system 0, a system', exact: true })).toBeVisible();
  return { calls };
}

async function expectNoSeriousViolations(page: Page) {
  if (process.env['KS_SKIP_AXE']) return;
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => ({ rule: v.id, nodes: v.nodes.map((node) => node.target.join(' ')) }))).toEqual([]);
}

for (const { name, size } of [
  { name: 'phone', size: { width: 390, height: 844 } },
  { name: 'desktop', size: { width: 1440, height: 900 } },
]) {
  test.describe(`a ${name}`, () => {
    test('a system with no planet yet opens its Reels and Scrolls, and a Reel opens by its address', async ({
      page,
    }) => {
      // One system and nothing under it.
      const { calls } = await openUniverse(page, size, 1);
      await page.getByRole('button', { name: 'CI system 0, a system', exact: true }).click();
      // On the desktop a first click picks a far system; the card's Open goes in.
      const openSystem = page.getByRole('button', { name: 'Open system' });
      if (await openSystem.isVisible()) await openSystem.click();
      await page.getByRole('button', { name: 'Watch or read in CI system 0' }).click();
      const sheet = page.getByTestId('universe-system-finds');
      await expect(sheet.getByRole('link', { name: 'Watch How attention picks its words' })).toBeVisible();
      await expect(sheet.getByRole('link', { name: 'Read Why transformers read in parallel' })).toBeVisible();
      if (shots) await page.screenshot({ path: `${shots}/system-finds-${name}.png` });
      await expectNoSeriousViolations(page);
      // Opening the list only read: nothing was opened, activated or recorded.
      expect(calls.filter((call) => /open|activate|observations|actions/.test(call.path))).toEqual([]);
      await sheet.getByRole('link', { name: 'Watch How attention picks its words' }).click();
      await expect(page).toHaveURL(new RegExp(`/reel/${fixtureId(600)}`));
    });
  });
}
