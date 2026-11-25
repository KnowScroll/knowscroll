import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import seasonsV3 from '@knowscroll/scroll-model/fixtures/seasons-v3-ci.json';
import blocks from '@knowscroll/scroll-model/fixtures/scale-chart-blocks-ci.json';
import { encounterFixture, id, readCover, type EncounterFixtureOptions } from './encounter-fixture';

/**
 * Moving between Parts and topics in the Scroll reader (#497, part B) in the production export over labelled HTTP fixtures:
 * the note a Part arrives with and the link back to the Part before. The document is the
 * labelled CI fixture `seasons-stage-ci` (not product content). Screenshots are written only when `KS_FIDELITY_SHOTS`
 * names a folder (outside the repository).
 */
const phone = { width: 390, height: 844 };

async function shot(page: Page, name: string) {
  const folder = process.env['KS_FIDELITY_SHOTS'];
  if (folder === undefined) return;
  mkdirSync(folder, { recursive: true });
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

/** Explore on the fixture Scroll, opened as a person does: from its cover, or at once when the offer has none. */
async function open(page: Page, viewport = phone, fixture: EncounterFixtureOptions = {}) {
  const served = await encounterFixture(page, 'scroll', {
    series: true,
    viewport,
    scrollDocument: seasons as unknown as Record<string, unknown>,
    ...fixture,
  });
  await page.goto('/explore');
  if (fixture.covers?.absent !== true) await readCover(page);
  await expect(heading(page)).toHaveText('CI encounter fixture 1');
  await page.getByRole('button', { name: 'Got it' }).click();
  return served;
}

/** The Scroll's title in the top bar (the essay repeats it in its opening). */
const heading = (page: Page) => page.getByTestId('reader-top-title').getByRole('heading', { level: 1 });

test('the button opens the Part with a note that the place in the Part before is kept, and a link back to it', async ({
  page,
}) => {
  await open(page);
  await expect(page.getByTestId('folio-arrival')).toHaveCount(0);
  await expect(page.getByTestId('folio-previous-part')).toHaveCount(0);
  await page.getByRole('button', { name: /^Part 2: / }).click();
  await expect(heading(page)).not.toHaveText('CI encounter fixture 1');
  await expect(page.getByTestId('folio-arrival')).toHaveText('Part 2 · your place in Part 1 is kept');
  const back = page.getByTestId('folio-previous-part');
  await expect(back).toBeVisible();
  await shot(page, 'part-2-arrived-390x844');
  expect(await audit(page)).toEqual([]);
  await back.click();
  await expect(heading(page)).toHaveText('CI encounter fixture 1');
});

test('on a Scroll’s own address a step forward says the place in the Part before is kept, and a reload does not', async ({
  page,
}) => {
  await encounterFixture(page, 'scroll', {
    viewport: phone,
    direct: { parts: 3 },
    scrollDocument: seasons as unknown as Record<string, unknown>,
  });
  await page.goto(`/scroll/${id(300)}`);
  await expect(page.getByTestId('scroll-reader')).toBeVisible();
  await expect(page.getByTestId('folio-arrival')).toHaveCount(0);
  await expect(page.getByTestId('folio-previous-part')).toHaveCount(0);
  await page.getByRole('button', { name: /^Part 2: / }).click();
  await expect(page.getByTestId('folio-arrival')).toHaveText('Part 2 · your place in Part 1 is kept');
  await expect(page.getByTestId('folio-previous-part')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/scroll/${id(301)}$`));
  await page.reload();
  await expect(page.getByTestId('scroll-reader')).toBeVisible();
  await expect(page.getByTestId('folio-arrival')).toHaveCount(0);
  // The link is the Part before, in the opening whenever one was admitted.
  await expect(page.getByTestId('folio-previous-part')).toBeVisible();
});

for (const width of [320, 390]) {
  for (const [label, fixture] of [
    // A document v3 draws pictures; a stored v2 Scroll's stage is not drawn any more (#835), so its Part has none, like `blocks`.
    ['a Part with a picture', seasonsV3],
    ['a Part with no picture', blocks],
    ['a Part with a stored stage, not drawn', seasons],
  ] as const) {
    test(`at ${String(width)} px the reader of ${label} has nothing past the right edge (#648)`, async ({ page }) => {
      await encounterFixture(page, 'scroll', {
        viewport: { width, height: 844 },
        series: true,
        scrollDocument: fixture as unknown as Record<string, unknown>,
      });
      await page.goto('/explore');
      await readCover(page);
      await page.getByRole('button', { name: 'Got it' }).click();
      await expect(page.getByTestId('reader-dock')).toBeVisible();
      const past = await page.evaluate((limit) => {
        const found: string[] = [];
        for (const node of document.querySelectorAll<HTMLElement>('body *')) {
          const box = node.getBoundingClientRect();
          if (box.width > 0 && box.right > limit + 0.5)
            found.push(`${node.getAttribute('aria-label') ?? node.tagName} right=${box.right.toFixed(1)}`);
        }
        return found;
      }, width);
      expect(past).toEqual([]);
    });
  }
}

test('F switches to the Reel with no click or Tab first: the reader has focus', async ({ page }) => {
  await open(page, phone);
  await page.getByTestId('scroll-reader').focus();
  const requests: string[] = [];
  page.on('request', (request) => requests.push(new URL(request.url()).pathname));
  await page.keyboard.press('f');
  await expect.poll(() => requests.some((path) => path === '/v1/experience/navigate')).toBe(true);
});
