import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import { encounterFixture } from './encounter-fixture';

/**
 * The end of a Scroll in the reader (#497, part C) in the production export over labelled HTTP fixtures: the pinned picture
 * becomes the picture of the whole journey ("the picture you built"), made of the document's own states, and the next Part
 * peeks in from the right edge. The document is the labelled CI fixture `seasons-stage-ci` (not product content). Screenshots
 * are written only when `KS_FIDELITY_SHOTS` names a folder (outside the repository).
 */
const phone = { width: 390, height: 844 };
const desktop = { width: 1440, height: 900 };

async function shot(page: Page, name: string) {
  const folder = process.env['KS_FIDELITY_SHOTS'];
  if (folder === undefined) return;
  mkdirSync(folder, { recursive: true });
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(folder, `${name}.png`) });
}

async function audit(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(' | ')}`);
}

async function open(page: Page, viewport = phone) {
  await encounterFixture(page, 'scroll', {
    series: true,
    viewport,
    scrollDocument: seasons as unknown as Record<string, unknown>,
  });
  await page.goto('/explore');
  await expect(page.getByRole('heading', { level: 1, name: 'CI encounter fixture 1' })).toBeVisible();
  await page.getByRole('button', { name: 'Got it' }).click();
}

const stage = (page: Page) => page.getByTestId('stage');
const end = (page: Page) => page.getByRole('button', { name: 'The end of this Scroll', exact: true });

for (const viewport of [phone, desktop]) {
  const name = `${String(viewport.width)}x${String(viewport.height)}`;

  test(`at the end the picture is the journey: an Earth numbered at each month the Scroll shows, and the next Part peeks in, at ${name}`, async ({
    page,
  }) => {
    await open(page, viewport);
    await expect(stage(page)).not.toHaveAttribute('data-ks-stage-state', 'recap');
    await expect(page.getByTestId('part-edge-peek')).toHaveCount(0);
    await end(page).click();
    await expect(stage(page)).toHaveAttribute('data-ks-stage-state', 'recap');
    // The fixture meets June, January (the stretched orbit) and March on its orbit views, in that order.
    await expect(stage(page).getByRole('img')).toHaveAccessibleName(
      /The picture you built: .*marked 1 in June, 2 in January and 3 in March, numbered in the order the Scroll shows them/,
    );
    for (const n of [1, 2, 3]) await expect(stage(page).getByTestId(`recap-earth-${String(n)}`)).toBeVisible();
    await expect(stage(page).getByTestId('recap-earth-4')).toHaveCount(0);
    const peek = page.getByTestId('part-edge-peek');
    await expect(peek).toBeVisible();
    await expect(peek).toHaveText('PART 2');
    const stageBox = await stage(page).boundingBox();
    const peekBox = await peek.boundingBox();
    // It sits on the right edge of the picture, within it.
    expect(stageBox && peekBox && peekBox.x + peekBox.width >= stageBox.x + stageBox.width - 2).toBe(true);
    expect(
      stageBox && peekBox && peekBox.y >= stageBox.y && peekBox.y + peekBox.height <= stageBox.y + stageBox.height,
    ).toBe(true);
    await shot(page, `recap-${name}`);
    expect(await audit(page)).toEqual([]);
    // Going back up to a stop gives the stop's own picture back.
    await page.getByRole('button', { name: 'Stop 1 of 12', exact: true }).click();
    await expect(stage(page)).toHaveAttribute('data-ks-stage-state', 'the-lean');
    await expect(page.getByTestId('part-edge-peek')).toHaveCount(0);
  });

  test(`the peek opens the next Part, and the tray no longer carries a Part card, at ${name}`, async ({ page }) => {
    await open(page, viewport);
    await end(page).click();
    await expect(page.getByTestId('part-peek')).toHaveCount(0);
    await expect(page.getByTestId('end-tray').getByRole('button', { name: 'Done for today' })).toBeVisible();
    await page.getByTestId('part-edge-peek').click();
    await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('CI encounter fixture 1');
  });
}

test('the text version at the end says the journey in words, and reduced motion draws the same recap', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  await end(page).click();
  await expect(stage(page)).toHaveAttribute('data-ks-stage-state', 'recap');
  await page.getByRole('button', { name: 'Text version' }).click();
  await expect(stage(page)).toContainText('The picture you built: Earth circles the Sun');
  await expect(stage(page).getByTestId('recap-earth-1')).toHaveCount(0);
});

for (const viewport of [
  { width: 320, height: 640 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
]) {
  test(`the recap is whole inside the picture and the next Part's tab covers none of it, at ${String(viewport.width)} px`, async ({
    page,
  }) => {
    await open(page, viewport);
    await end(page).click();
    await expect(stage(page)).toHaveAttribute('data-ks-stage-state', 'recap');
    const frame = await stage(page).boundingBox();
    const tab = await page.getByTestId('part-edge-peek').boundingBox();
    if (frame === null || tab === null) throw new Error('the picture and the tab are drawn');
    for (const n of [1, 2, 3]) {
      const earth = await stage(page)
        .getByTestId(`recap-earth-${String(n)}`)
        .boundingBox();
      if (earth === null) throw new Error(`Earth ${String(n)} is drawn`);
      // Whole inside the picture, in both directions.
      expect(earth.x).toBeGreaterThanOrEqual(frame.x);
      expect(earth.y).toBeGreaterThanOrEqual(frame.y);
      expect(earth.x + earth.width).toBeLessThanOrEqual(frame.x + frame.width);
      expect(earth.y + earth.height).toBeLessThanOrEqual(frame.y + frame.height);
      // Clear of the tab: the two boxes do not overlap.
      const overlaps =
        earth.x < tab.x + tab.width &&
        earth.x + earth.width > tab.x &&
        earth.y < tab.y + tab.height &&
        earth.y + earth.height > tab.y;
      expect(overlaps, `Earth ${String(n)} under the tab`).toBe(false);
    }
    await shot(page, `recap-${String(viewport.width)}`);
  });
}
