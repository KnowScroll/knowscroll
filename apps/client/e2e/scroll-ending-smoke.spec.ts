import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import { encounterFixture, id } from './encounter-fixture';

/**
 * The end of a Scroll in the reader (#497, part C) in the production export over labelled HTTP fixtures: the end plate draws
 * the picture of the whole journey ("the picture you built"), made of the document's own states, and its buttons lead on
 * (Part 2, Close). The document is the labelled CI fixture `seasons-stage-ci` (not product content). Screenshots are
 * written only when `KS_FIDELITY_SHOTS` names a folder (outside the repository).
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
  // The offer's own title heads the Scroll in the bar, and the essay repeats it in its opening.
  await expect(
    page.getByTestId('reader-top-title').getByRole('heading', { level: 1, name: 'CI encounter fixture 1' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Got it' }).click();
}

const reader = (page: Page) => page.getByRole('group', { name: 'Scroll reader' });
const plate = (page: Page) => page.getByTestId('end-plate');
const journey = (page: Page) => page.getByTestId('end-figure');

/**
 * Goes to the end, as a person who pressed End, and waits until the scroll has arrived: the scroll is smooth, and a plate
 * taller than the screen passes through the view on its way to the bottom.
 */
async function toTheEnd(page: Page) {
  await reader(page).focus();
  await page.keyboard.press('End');
  const scroller = page.getByTestId('folio-scroller');
  await expect
    .poll(() => scroller.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight))
    .toBeLessThan(2);
  await expect(plate(page).getByText('The short version')).toBeVisible();
}

for (const viewport of [phone, desktop]) {
  const name = `${String(viewport.width)}x${String(viewport.height)}`;

  test(`the end plate draws the journey: an Earth numbered at each month the Scroll shows, at ${name}`, async ({
    page,
  }) => {
    await open(page, viewport);
    await toTheEnd(page);
    // The fixture meets June, January (the stretched orbit) and March on its orbit views, in that order.
    await expect(journey(page).getByRole('img')).toHaveAccessibleName(
      /The picture you built: .*marked 1 in June, 2 in January and 3 in March, numbered in the order the Scroll shows them/,
    );
    for (const n of [1, 2, 3]) await expect(journey(page).getByTestId(`recap-earth-${String(n)}`)).toBeVisible();
    await expect(journey(page).getByTestId('recap-earth-4')).toHaveCount(0);
    await shot(page, `recap-${name}`);
    expect(await audit(page)).toEqual([]);
  });

  test(`the end plate's Part 2 button opens the next Part, at ${name}`, async ({ page }) => {
    await open(page, viewport);
    await toTheEnd(page);
    await plate(page)
      .getByRole('button', { name: /^Part 2 · / })
      .click();
    await expect(page.getByTestId('reader-top-title').getByRole('heading', { level: 1 })).not.toHaveText(
      'CI encounter fixture 1',
    );
  });
}

test('Close on the end plate leaves a Scroll opened by its address', async ({ page }) => {
  await encounterFixture(page, 'scroll', {
    viewport: phone,
    direct: { parts: 2 },
    scrollDocument: seasons as unknown as Record<string, unknown>,
  });
  await page.goto(`/scroll/${id(300)}`);
  await expect(page.getByTestId('scroll-reader')).toBeVisible();
  await toTheEnd(page);
  await plate(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page).toHaveURL(/\/explore$/);
});

test('the text version at the end says the journey in words, and reduced motion draws the same recap', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  await toTheEnd(page);
  for (const n of [1, 2, 3]) await expect(journey(page).getByTestId(`recap-earth-${String(n)}`)).toBeVisible();
  await reader(page).focus();
  await page.keyboard.press('t');
  await expect(journey(page)).toContainText('The picture you built: Earth circles the Sun');
  await expect(journey(page).getByTestId('recap-earth-1')).toHaveCount(0);
});

for (const viewport of [
  { width: 320, height: 640 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
]) {
  test(`the recap is whole inside the picture, at ${String(viewport.width)} px`, async ({ page }) => {
    await open(page, viewport);
    await toTheEnd(page);
    const frame = await journey(page).getByRole('img').boundingBox();
    if (frame === null) throw new Error('the picture is drawn');
    for (const n of [1, 2, 3]) {
      const earth = await journey(page)
        .getByTestId(`recap-earth-${String(n)}`)
        .boundingBox();
      if (earth === null) throw new Error(`Earth ${String(n)} is drawn`);
      // Whole inside the picture, in both directions.
      expect(earth.x).toBeGreaterThanOrEqual(frame.x);
      expect(earth.y).toBeGreaterThanOrEqual(frame.y);
      expect(earth.x + earth.width).toBeLessThanOrEqual(frame.x + frame.width);
      expect(earth.y + earth.height).toBeLessThanOrEqual(frame.y + frame.height);
    }
    await shot(page, `recap-${String(viewport.width)}`);
  });
}
