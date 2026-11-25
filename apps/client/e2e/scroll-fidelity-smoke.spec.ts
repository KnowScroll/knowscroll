import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import seasonsV3 from '@knowscroll/scroll-model/fixtures/seasons-v3-ci.json';
import { coverFrameOfV3, describePicture, type ScrollDocumentV3 } from '@knowscroll/scroll-model';
import { answerActions, type ActionsState } from './actions-fixture';
import { encounterFixture, readCover } from './encounter-fixture';

/**
 * The Scroll reader's small fidelity fixes against the V3 frames (#497, part A) in the production export over labelled HTTP
 * fixtures: the Ask pill, Next with its word, the rows of the ••• sheet and what they do, their keys and the Share
 * a moment preview. The document is the labelled CI fixture `seasons-stage-ci` (not product content): a stored v2 Scroll
 * whose stage (Earth & sky's) is not drawn any more (#835), so it has no picture, no Text version row and no picture in the
 * Share a moment preview. What those do for a picture is checked on the labelled document v3 `seasons-v3-ci`.
 * Screenshots are written only when `KS_FIDELITY_SHOTS` names a folder (outside the repository).
 */
const phone = { width: 390, height: 844 };
const desktop = { width: 1440, height: 900 };
const small = { width: 320, height: 640 };

async function shot(page: Page, name: string) {
  const folder = process.env['KS_FIDELITY_SHOTS'];
  if (folder === undefined) return;
  mkdirSync(folder, { recursive: true });
  await page.waitForTimeout(450);
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

async function open(page: Page, viewport = phone, actions?: ActionsState, document: Record<string, unknown> = seasons) {
  const served = await encounterFixture(page, 'scroll', {
    ...(actions === undefined ? {} : { actions }),
    series: true,
    viewport,
    scrollDocument: document,
  });
  await page.goto('/explore');
  await readCover(page);
  await expect(
    page.getByTestId('reader-top-title').getByRole('heading', { level: 1, name: 'CI encounter fixture 1' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Got it' }).click();
  return served;
}

const rowsOf = (page: Page) => page.getByTestId('more-list').getByRole('listitem');

for (const viewport of [phone, desktop]) {
  const name = `${String(viewport.width)}x${String(viewport.height)}`;

  test(`the dock is Like, Share and Save with a small word under each, then ••• and Part 2, at ${name}`, async ({
    page,
  }) => {
    await open(page, viewport);
    const dock = page.getByTestId('reader-dock');
    // Each control is a 44 px target, in order, with its word under it (D-429).
    let left = 0;
    for (const [button, word] of [
      ['Like', 'Like'],
      ['Share a moment', 'Share'],
      ['Save', 'Save'],
    ] as const) {
      const box = await dock.getByRole('button', { name: button, exact: true }).boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.x).toBeGreaterThanOrEqual(left);
      left = box!.x + box!.width;
      await expect(dock.getByText(word, { exact: true })).toBeVisible();
    }
    // Ask is the first row of •••, not a pill in the dock.
    await expect(dock.getByRole('button', { name: 'Ask about this' })).toHaveCount(0);
    await shot(page, `dock-${name}`);
    expect(await audit(page)).toEqual([]);
  });

  test(`the ••• sheet is five rows, Ask about this first, each with its sub-line and key, at ${name}`, async ({
    page,
  }) => {
    await open(page, viewport);
    await page.getByRole('button', { name: 'More', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'More' });
    await expect(dialog).toBeVisible();
    // Ask, Challenge (the fixture's Scroll has calls), Simpler, Small print, Report: no Save, no Share a moment (D-429), and no
    // Text version, which a Scroll has only where it has a picture (this stored v2 Scroll's stage is not drawn).
    await expect(rowsOf(page)).toHaveCount(5);
    const titles = await rowsOf(page)
      .getByRole('button')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')));
    expect(titles).toEqual(['Ask about this', 'Challenge a friend', 'Simpler (this screen)', 'Small print', 'Report']);
    await expect(page.getByTestId('more-ask-detail')).toHaveText('A question about the part you are reading');
    // The shift sign carries U+FE0E so no system draws it as an emoji.
    for (const key of [/^A$/, /^C$/, /^⇧︎?S$/, /^P$/, /^R$/])
      await expect(page.getByTestId('more-list').getByText(key)).toBeVisible();
    await shot(page, `more-${name}`);
    // The sheet fades in over the page; judge it once it has settled.
    await expect.poll(() => audit(page)).toEqual([]);
  });

  test(`Simpler, Small print and Report each do their work from the ••• sheet, at ${name}`, async ({ page }) => {
    await open(page, viewport);
    const more = () => page.getByRole('button', { name: 'More', exact: true }).click();
    // Simpler swaps the stop on screen for its plainer words.
    await more();
    await page.getByTestId('more-simpler').click();
    await expect(page.getByTestId('simpler-text')).toBeVisible();
    // Small print opens the limits aside.
    await more();
    await page.getByTestId('more-small-print').click();
    const print = page.getByRole('dialog', { name: 'Small print' });
    await expect(print).toContainText('Where this stops');
    await expect(print).toContainText(/Light sets the season/);
    await shot(page, `small-print-${name}`);
    await print.getByRole('button', { name: 'Close' }).click();
    // Report opens the content-error report for the stop on screen.
    await more();
    await page.getByTestId('more-report').click();
    await expect(page.getByRole('dialog', { name: 'Report' })).toBeVisible();
    await shot(page, `report-${name}`);
  });

  test(`Share a moment shows the stop and its words before a thread is chosen, with no picture, at ${name}`, async ({
    page,
  }) => {
    await open(page, viewport);
    await page.getByTestId('reader-dock').getByRole('button', { name: 'Share a moment' }).click();
    const sheet = page.getByRole('dialog', { name: 'Share a moment' });
    await expect(sheet.getByTestId('moment-preview')).toBeVisible();
    // The card never carries a picture and no drawing kit is left to draw the stop's (#835): words alone, as for a v3 beat.
    await expect(sheet.getByTestId('moment-picture')).toHaveCount(0);
    await expect(sheet.getByTestId('moment-quote')).toContainText('It leans.');
    await shot(page, `share-moment-preview-${name}`);
    // The sheet fades in over the page; judge it once it has settled.
    await expect.poll(() => audit(page)).toEqual([]);
  });

  test(`Text version from the ••• sheet turns every picture of a document v3 Scroll into its words, and the row says it is on, at ${name}`, async ({
    page,
  }) => {
    // The document v3 counterpart of the v2 case this test had for Earth & sky's picture: the row exists only where there is a picture.
    const frame = coverFrameOfV3(seasonsV3 as unknown as ScrollDocumentV3);
    if (frame === undefined) throw new Error('the fixture shows a picture');
    const words = describePicture(frame.picture, frame.state);
    await open(page, viewport, undefined, seasonsV3);
    const more = () => page.getByRole('button', { name: 'More', exact: true }).click();
    await more();
    await page.getByTestId('more-text-version').click();
    await expect(page.getByRole('dialog', { name: 'More' })).toHaveCount(0);
    const figure = page.locator('[data-ks-figure]').first();
    await expect(figure).toContainText(words);
    await expect(figure.getByRole('img')).toHaveCount(0);
    await more();
    await expect(page.getByTestId('more-text-version-detail')).toHaveText('Showing the picture as words');
    await page.getByTestId('more-text-version').click();
    await expect(figure.getByRole('img')).toBeVisible();
    await expect(figure).not.toContainText(words);
  });
}

test('the keys of the dock and the ••• rows act from the reader: L, S, H, C, ⇧S, P and R, each doing what its control does', async ({
  page,
}) => {
  const state = { saved: false, liked: false, hidden: false };
  await open(page, desktop, state);
  await answerActions(page, state);
  await page.getByRole('group', { name: 'Scroll reader' }).focus();
  // L is Like: it sends the like action for this Scroll.
  const likes = page.waitForRequest((request) => new URL(request.url()).pathname === '/v1/actions');
  await page.keyboard.press('l');
  expect(JSON.parse((await likes).postData() ?? '{}')).toMatchObject({ kind: 'like' });
  await expect(page.getByTestId('reader-dock').getByRole('button', { name: 'Like', pressed: true })).toBeVisible();
  // A press is ignored while the one before is settling.
  await expect(page.getByTestId('reader-dock').getByRole('button', { name: 'Like' })).not.toHaveAttribute(
    'aria-busy',
    'true',
  );
  // S alone is Save (not Simpler): it sends the save action for this Scroll, and changes no stop's words.
  const saves = page.waitForRequest((request) => new URL(request.url()).pathname === '/v1/actions');
  await page.keyboard.press('s');
  expect(JSON.parse((await saves).postData() ?? '{}')).toMatchObject({ kind: 'save' });
  await expect(page.getByTestId('simpler-text')).toHaveCount(0);
  await page.keyboard.press('Shift+S');
  await expect(page.getByTestId('simpler-text')).toBeVisible();
  await page.keyboard.press('Shift+S');
  await expect(page.getByTestId('simpler-text')).toHaveCount(0);
  await page.keyboard.press('h');
  await expect(page.getByRole('dialog', { name: 'Share a moment' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Share a moment' })).toHaveCount(0);
  await page.getByRole('group', { name: 'Scroll reader' }).focus();
  await page.keyboard.press('p');
  await expect(page.getByRole('dialog', { name: 'Small print' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('group', { name: 'Scroll reader' }).focus();
  await page.keyboard.press('r');
  await expect(page.getByRole('dialog', { name: 'Report' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('group', { name: 'Scroll reader' }).focus();
  await page.keyboard.press('c');
  await expect(page.getByRole('dialog', { name: 'Challenge a friend' })).toBeVisible();
});

/** Opens the fixture Scroll under another title, to see what the bar does with a short one and a long one. */
async function openTitled(page: Page, title: string, viewport = phone) {
  await encounterFixture(page, 'scroll', {
    series: true,
    viewport,
    scrollDocument: seasons as unknown as Record<string, unknown>,
    firstTitle: title,
  });
  await page.goto('/explore');
  await readCover(page);
  await expect(page.getByTestId('reader-top-title').getByRole('heading', { level: 1, name: title })).toBeVisible();
  await page.getByRole('button', { name: 'Got it' }).click();
}

test('Next says its word on a phone when the title leaves room, and keeps to its arrow when it does not (D-185)', async ({
  page,
}) => {
  await openTitled(page, 'It leans');
  const bar = page.getByTestId('reader-top-bar');
  await expect(bar.getByText('Next', { exact: true })).toBeVisible();
  await shot(page, 'next-short-title-390x844');
  const next = await bar.getByRole('button', { name: 'Next topic' }).boundingBox();
  expect(next && next.x + next.width <= phone.width).toBe(true);
  expect(await audit(page)).toEqual([]);
});

test('a long title takes the word back, so the bar stays one line and nothing is clipped', async ({ page }) => {
  await openTitled(page, 'Why Summer Does Not Come From Distance');
  const bar = page.getByTestId('reader-top-bar');
  await expect(bar.getByRole('button', { name: 'Next topic' })).toBeVisible();
  await expect(bar.getByText('Next', { exact: true })).toHaveCount(0);
  const [barBox, next] = [await bar.boundingBox(), await bar.getByRole('button', { name: 'Next topic' }).boundingBox()];
  expect(barBox && next && next.y + next.height <= barBox.y + barBox.height).toBe(true);
  expect(barBox && barBox.height < 90).toBe(true);
  await shot(page, 'next-long-title-390x844');
});

test('Next says its word on a desktop, and is its arrow alone at 320 px', async ({ page }) => {
  await openTitled(page, 'It leans', desktop);
  const bar = page.getByTestId('reader-top-bar');
  await expect(bar.getByText('Next', { exact: true })).toBeVisible();
  await shot(page, 'next-1440x900');
  await page.setViewportSize(small);
  await expect(bar.getByText('Next', { exact: true })).toHaveCount(0);
  await expect(bar.getByRole('button', { name: 'Next topic' })).toBeVisible();
  await shot(page, 'next-320x640');
});
