import { expect, test, type Page } from '@playwright/test';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import { encounterFixture, id, readCover } from './encounter-fixture';

/**
 * The end of a Scroll in the reader (#497, part C) in the production export over labelled HTTP fixtures: the end plate's
 * buttons lead on (Part 2, Close). The document is the labelled CI fixture `seasons-stage-ci` (not product content). The
 * end plate once drew the picture of the whole journey ("the picture you built") of Earth & sky's stage; that kit is deleted
 * (#835) and a v2 Scroll's end plate has none. The end plate's own summary, small print and axe are in `payoff-smoke.spec.ts`.
 */
const phone = { width: 390, height: 844 };
const desktop = { width: 1440, height: 900 };

async function open(page: Page, viewport = phone) {
  await encounterFixture(page, 'scroll', {
    series: true,
    viewport,
    scrollDocument: seasons as unknown as Record<string, unknown>,
  });
  await page.goto('/explore');
  await readCover(page);
  // The offer's own title heads the Scroll in the bar, and the essay repeats it in its opening.
  await expect(
    page.getByTestId('reader-top-title').getByRole('heading', { level: 1, name: 'CI encounter fixture 1' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Got it' }).click();
}

const reader = (page: Page) => page.getByRole('group', { name: 'Scroll reader' });
const plate = (page: Page) => page.getByTestId('end-plate');

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
  await expect(plate(page).getByText('To sum up')).toBeVisible();
}

for (const viewport of [phone, desktop]) {
  const name = `${String(viewport.width)}x${String(viewport.height)}`;

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
