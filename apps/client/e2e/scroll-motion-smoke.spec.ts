import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import blocks from '@knowscroll/scroll-model/fixtures/scale-chart-blocks-ci.json';
import { encounterFixture, id } from './encounter-fixture';

/**
 * Moving between Parts and topics in the Scroll reader (#497, part B) in the production export over labelled HTTP fixtures:
 * the note a Part arrives with and the link back to the Part before, and the note after Next ↑. The document is the
 * labelled CI fixture `seasons-stage-ci` (not product content). Screenshots are written only when `KS_FIDELITY_SHOTS`
 * names a folder (outside the repository).
 */
const phone = { width: 390, height: 844 };
const desktop = { width: 1440, height: 900 };

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

async function open(page: Page, viewport = phone) {
  const served = await encounterFixture(page, 'scroll', {
    series: true,
    viewport,
    scrollDocument: seasons as unknown as Record<string, unknown>,
  });
  await page.goto('/explore');
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

test('after Next ↑ the note says it is the next topic as a Scroll, offers the Reel and Undo, and Undo goes back', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('button', { name: 'Next topic' }).click();
  await expect(heading(page)).toHaveText('CI encounter fixture 2');
  const note = page.getByTestId('format-note');
  await expect(note).toContainText('NEXT TOPIC · AS A SCROLL');
  await expect(note).toContainText('CI encounter fixture 2');
  await expect(page.getByTestId('format-note-kept')).toContainText('is kept');
  await expect(page.getByTestId('format-note-switch')).toBeVisible();
  await shot(page, 'format-note-390x844');
  expect(await audit(page)).toEqual([]);
  await page.getByTestId('format-note-undo').click();
  await expect(heading(page)).toHaveText('CI encounter fixture 1');
  await expect(note).toHaveCount(0);
});

test('Esc undoes the new topic while the note is showing, and the note is not said for a Part', async ({ page }) => {
  await open(page);
  // The key N from the reader group: focus is not taken into the note (that would hold its timer for good), and the
  // reader's own keys act with no click or Tab first.
  await page.getByTestId('scroll-reader').focus();
  await page.keyboard.press('n');
  await expect(page.getByTestId('format-note')).toBeVisible();
  await expect(page.getByTestId('scroll-reader')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(heading(page)).toHaveText('CI encounter fixture 1');
  await expect(page.getByTestId('scroll-reader')).toBeFocused();
  await page.getByRole('button', { name: /^Part 2: / }).click();
  await expect(page.getByTestId('folio-arrival')).toBeVisible();
  await expect(page.getByTestId('format-note')).toHaveCount(0);
});

/** Whether focus is inside the note. */
const focusInNote = (page: Page) =>
  page.evaluate(() => document.querySelector('[data-testid="format-note"]')?.contains(document.activeElement) ?? false);

for (const { label, viewport } of [
  { label: '390 × 844', viewport: phone },
  { label: '1440 × 900', viewport: desktop },
]) {
  test(`at ${label} the note puts itself away after nine seconds with no one touching it, and takes no focus (#648)`, async ({
    page,
  }) => {
    await page.clock.install();
    await open(page, viewport);
    await page.getByRole('button', { name: 'Next topic' }).click();
    const note = page.getByTestId('format-note');
    await expect(note).toBeVisible();
    expect(await focusInNote(page)).toBe(false);
    await page.clock.runFor(8_000);
    await expect(note).toBeVisible();
    await page.clock.runFor(1_500);
    await expect(note).toHaveCount(0);
  });
}

test('the note waits while the pointer is over it or focus is in it by the person’s own doing, and then goes', async ({
  page,
}) => {
  await page.clock.install();
  await open(page);
  await page.getByRole('button', { name: 'Next topic' }).click();
  const note = page.getByTestId('format-note');
  await expect(note).toBeVisible();
  await note.hover();
  await page.clock.runFor(30_000);
  await expect(note).toBeVisible();
  await page.mouse.move(5, 400);
  // Tab into it: the person's own focus holds it too.
  await page.getByTestId('format-note-undo').focus();
  await page.clock.runFor(30_000);
  await expect(note).toBeVisible();
  // Focus moves on to another control of the reader: the hold ends, and the note's going takes nothing from that control.
  const ask = page.getByTestId('reader-dock').getByRole('button', { name: 'Like', exact: true });
  await ask.focus();
  await page.clock.runFor(8_000);
  await expect(note).toBeVisible();
  await page.clock.runFor(1_500);
  await expect(note).toHaveCount(0);
  await expect(ask).toBeFocused();
});

test('the note is drawn at 1440 × 900 too', async ({ page }) => {
  await open(page, desktop);
  await page.getByRole('button', { name: 'Next topic' }).click();
  await expect(page.getByTestId('format-note')).toBeVisible();
  await shot(page, 'format-note-1440x900');
  expect(await audit(page)).toEqual([]);
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
    ['a Part with a picture', seasons],
    ['a Part with no picture', blocks],
  ] as const) {
    test(`at ${String(width)} px the reader of ${label} has nothing past the right edge (#648)`, async ({ page }) => {
      await encounterFixture(page, 'scroll', {
        viewport: { width, height: 844 },
        series: true,
        scrollDocument: fixture as unknown as Record<string, unknown>,
      });
      await page.goto('/explore');
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

test('F switches to the Reel with no click or Tab first: the reader has focus, not the note', async ({ page }) => {
  await open(page);
  await page.getByTestId('scroll-reader').focus();
  await page.keyboard.press('n');
  await expect(page.getByTestId('format-note')).toBeVisible();
  await expect(page.getByTestId('scroll-reader')).toBeFocused();
  const requests: string[] = [];
  page.on('request', (request) => requests.push(new URL(request.url()).pathname));
  await page.keyboard.press('f');
  await expect.poll(() => requests.some((path) => path === '/v1/experience/navigate')).toBe(true);
});

test('at 320 px the note sits below the whole top bar, wrapped as it is, and covers none of its controls', async ({
  page,
}) => {
  await open(page, { width: 320, height: 640 });
  await page.getByRole('button', { name: 'Next topic' }).click();
  const note = await page.getByTestId('format-note').boundingBox();
  const bar = await page.getByTestId('reader-top-bar').boundingBox();
  if (note === null || bar === null) throw new Error('the note and the bar are drawn');
  expect(note.y).toBeGreaterThanOrEqual(bar.y + bar.height - 1);
  for (const name of ['Your Universe', 'Next topic']) {
    const control = await page.getByRole('button', { name, exact: true }).boundingBox();
    expect(control && control.y + control.height <= note.y + 1).toBe(true);
  }
  await shot(page, 'format-note-320x640');
});

for (const viewport of [{ width: 320, height: 568 }, phone, desktop]) {
  test(`Next lands on a library article and the note is there too, below the bar, with Undo, at ${String(viewport.width)} px (D-391)`, async ({
    page,
  }) => {
    // The default fixture is a v1 article: the reader that has no stage.
    await encounterFixture(page, 'scroll', { viewport });
    await page.goto('/explore');
    await expect(page.getByRole('heading', { level: 1, name: 'CI encounter fixture 1' })).toBeVisible();
    await page.getByRole('button', { name: 'Got it' }).click();
    await expect(page.getByTestId('scroll-reader')).toHaveCount(0);
    await expect(page.getByTestId('format-note')).toHaveCount(0);
    await page.getByRole('button', { name: 'Next subject', exact: true }).last().click();
    await expect(page.getByRole('heading', { level: 1, name: 'CI encounter fixture 2' })).toBeVisible();
    const note = page.getByTestId('format-note');
    await expect(note).toContainText('NEXT TOPIC · AS A SCROLL');
    await expect(note).toContainText('CI encounter fixture 2');
    await expect(page.getByTestId('format-note-kept')).toHaveText('CI encounter fixture 1 is kept.');
    const box = await note.boundingBox();
    const back = await page.getByRole('button', { name: 'Back', exact: true }).boundingBox();
    if (box === null || back === null) throw new Error('the note and Back are drawn');
    // Below the bar's controls, so none of them is covered.
    expect(box.y).toBeGreaterThanOrEqual(back.y + back.height - 1);
    await shot(page, `format-note-article-${String(viewport.width)}x${String(viewport.height)}`);
    expect(await audit(page)).toEqual([]);
    await page.getByTestId('format-note-undo').click();
    await expect(page.getByRole('heading', { level: 1, name: 'CI encounter fixture 1' })).toBeVisible();
    await expect(note).toHaveCount(0);
  });
}
