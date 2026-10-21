import { expect, test } from '@playwright/test';
import { fixtureAccount, sceneFixture } from '../features/universe/universe.fixture';
/** Production-export consumer over authored HTTP fixtures. No established world/provider acceptance. */
test('authoritative map/outline/travel and browser Back keep camera private and perform reads only', async ({
  page,
}) => {
  const world = sceneFixture(),
    calls: string[] = [];
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/auth/session', (route) =>
    route.fulfill({ json: { account: fixtureAccount, client: 'web', expiresAt: '2099-10-21T00:00:00.000Z' } }),
  );
  await page.route('**/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    calls.push(path);
    return route.fulfill({ json: world.reply(path, route.request().postDataJSON() as Record<string, unknown>) });
  });
  await page.goto('/universe');
  await expect(page.getByRole('button', { name: 'Focus CI system 0, system' })).toBeVisible();
  await page.getByRole('button', { name: 'Focus CI system 0, system' }).click();
  await page.getByRole('button', { name: 'Focus CI planet 2, planet' }).click();
  await expect(page.getByRole('button', { name: 'Travel to CI planet 3' })).toBeVisible();
  await page.getByRole('button', { name: 'Travel to CI planet 3' }).click();
  await expect(page.getByRole('heading', { name: 'CI planet 3', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'CI planet 2', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await page.getByRole('button', { name: 'CI region 4 · region', exact: true }).click();
  await page.getByRole('button', { name: 'Place details', exact: true }).click();
  await expect(page.getByText('Encounters from this place aren’t available.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(calls.every((path) => path.startsWith('/v1/universe/'))).toBe(true);
  expect(await page.evaluate(() => JSON.stringify(history.state))).not.toMatch(/objectId|frame|seed|0199a000/);
  await page.getByRole('link', { name: 'Keep', exact: true }).click();
  await page.getByRole('link', { name: 'Universe', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'CI region 4', exact: true })).toBeVisible();
});
