import { expect, test } from '@playwright/test';
import { fixtureAccount, sceneFixture } from '../features/universe/universe.fixture';
/** Production-export consumer over authored HTTP fixtures. No established world/provider acceptance. */
test('authoritative map/outline/travel and browser Back keep camera private and perform reads only', async ({
  page,
}) => {
  const world = sceneFixture(),
    calls: string[] = [];
  const reads = new Set([
    '/v1/universe/geography/read',
    '/v1/universe/geography/deltas/read',
    '/v1/universe/scenes/manifest/read',
    '/v1/universe/scenes/chunks/read',
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/auth/session', (route) =>
    route.fulfill({ json: { account: fixtureAccount, client: 'web', expiresAt: '2099-10-21T00:00:00.000Z' } }),
  );
  await page.route('**/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    calls.push(path);
    // Fail at the actual HTTP boundary; unrelated bodyless requests are never draft fixtures.
    expect({ method: route.request().method(), path }).toEqual({ method: 'POST', path: expect.any(String) });
    expect(reads.has(path)).toBe(true);
    const body: unknown = route.request().postDataJSON();
    expect(body !== null && typeof body === 'object' && !Array.isArray(body)).toBe(true);
    return route.fulfill({ json: world.reply(path, body as Record<string, unknown>) });
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
  // Talk is an unmounted placeholder; this isolates tab lifetime from Keep's separate Saved reads.
  await page.getByRole('link', { name: 'Talk', exact: true }).click();
  await page.getByRole('link', { name: 'Universe', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'CI region 4', exact: true })).toBeVisible();
  expect(calls.every((path) => reads.has(path))).toBe(true);
});
