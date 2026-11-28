import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { tapOrbitingTarget } from './orbiting-target';
import { landed, openVoyage, shot, VOYAGE_READS } from './voyage-fixture';

/**
 * The level rail of the Universe's Round 7.3 look on trial (#811): at the right edge, one dot per stop you can go to
 * from where you are, the current one named; each is a button "Go to …" that flies there. With the switch off there is
 * no rail.
 */
const rail = (page: Page) => page.getByRole('toolbar', { name: /^Where you are/ });
const stop = (page: Page, name: string) => rail(page).getByRole('button', { name: `Go to ${name}`, exact: true });
const listed = (page: Page): Promise<(string | null)[]> =>
  rail(page)
    .getByRole('button')
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
const current = (page: Page) => rail(page).locator('[aria-current="true"]');

async function seriousViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({ rule: v.id, nodes: v.nodes.map((node) => node.target.join(' ')) }));
}

for (const size of [
  { name: 'a phone', width: 390, height: 844 },
  { name: 'a desktop', width: 1440, height: 900 },
] as const)
  test(`on ${size.name} the rail lists the stops you can reach, names the current one and flies to the one tapped`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const paths: string[] = [];
    await openVoyage(page, paths, { size, rooms: true });
    const system = page.getByRole('button', { name: 'CI system 0, a system', exact: true });
    await expect(system).toBeVisible({ timeout: 60_000 });
    await landed(page);
    expect(await listed(page)).toEqual(['Go to Other universes', 'Go to Universe']);
    await expect(current(page)).toHaveAttribute('aria-label', 'Go to Universe');
    await expect(current(page)).toContainText('Universe');
    expect(await seriousViolations(page)).toEqual([]);
    await shot(page, `rail-${String(size.width)}-1-universe`);

    await system.click();
    await expect(current(page)).toHaveAttribute('aria-label', 'Go to Star', { timeout: 30_000 });
    await landed(page);
    expect(await listed(page)).toEqual(['Go to Other universes', 'Go to Universe', 'Go to Star']);

    const planet = page.getByRole('button', { name: 'CI planet 2, a planet', exact: true });
    await tapOrbitingTarget(planet);
    await expect(current(page)).toHaveAttribute('aria-label', 'Go to Planet', { timeout: 30_000 });
    await landed(page);
    // At a planet of your own the ground is one stop down, and the rail goes there.
    expect(await listed(page)).toEqual([
      'Go to Other universes',
      'Go to Universe',
      'Go to Star',
      'Go to Planet',
      'Go to Ground',
    ]);
    await shot(page, `rail-${String(size.width)}-2-planet`);
    await stop(page, 'Ground').click();
    await expect(page.getByRole('button', { name: 'Map of CI planet 2' })).toBeVisible({ timeout: 30_000 });
    await expect(current(page)).toHaveAttribute('aria-label', 'Go to Ground');
    await landed(page);
    // The rail keeps names off what it draws, never off the pill under the landed ship.
    await expect(page.getByText('CI region 4 · you are here')).toBeVisible({ timeout: 30_000 });

    // From the ground, the star in one flight; then the whole universe.
    await stop(page, 'Star').click();
    await expect(page.getByRole('heading', { name: 'CI system 0' })).toBeVisible({ timeout: 30_000 });
    await landed(page);
    await stop(page, 'Universe').click();
    await expect(page.getByRole('heading', { name: 'Your universe' })).toBeVisible({ timeout: 30_000 });
    await landed(page);
    expect(await listed(page)).toEqual(['Go to Other universes', 'Go to Universe']);
    await shot(page, `rail-${String(size.width)}-3-universe-again`);

    // Looking around writes nothing.
    expect(paths.filter((path) => !VOYAGE_READS.has(path))).toEqual([]);
  });

test('with reduced motion the rail goes to a stop at once', async ({ page }) => {
  test.setTimeout(180_000);
  await openVoyage(page, [], { calm: true });
  const system = page.getByRole('button', { name: 'CI system 0, a system', exact: true });
  await expect(system).toBeVisible({ timeout: 60_000 });
  await system.click();
  await expect(current(page)).toHaveAttribute('aria-label', 'Go to Star', { timeout: 30_000 });
  await stop(page, 'Universe').click();
  await expect(page.getByRole('heading', { name: 'Your universe' })).toBeVisible({ timeout: 30_000 });
  await expect(current(page)).toHaveAttribute('aria-label', 'Go to Universe');
});

test('with the switch off there is no rail', async ({ page }) => {
  test.setTimeout(120_000);
  await openVoyage(page, [], { trial: false });
  await expect(page.getByRole('button', { name: 'CI system 0, a system', exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId('voyage-rail')).toHaveCount(0);
});
