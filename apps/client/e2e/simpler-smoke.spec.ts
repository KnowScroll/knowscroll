import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import { encounterFixture } from './encounter-fixture';

const playableVideo = readFileSync(join(__dirname, 'fixtures', 'blue-60s.webm'));

/**
 * Simpler, the selection menu and the Reels top bar (v3 S-9, D-244, D-246) in the production export over labelled HTTP fixtures.
 * Simpler swaps a stop for its own authored plainer words, in place, with Undo. Selecting words in a read stop offers
 * Simpler and Ask; Ask asks for a Quick answer under the stop (D-253, `quick-answer-smoke.spec.ts`) and sends no request for a Scroll.
 * A Reel has the same two top buttons a Scroll has: Your Universe and Next topic. The document is the labelled CI fixture
 * `seasons-stage-ci`. Screenshots are written only when `KS_SIMPLER_SHOTS` names a
 * folder (outside the repository).
 */
const phone = { width: 390, height: 844 };
const desktop = { width: 1440, height: 900 };
const small = { width: 320, height: 640 };
const first = seasons.stops[0] as { id: string; simple: string };

async function shot(page: Page, name: string) {
  const folder = process.env['KS_SIMPLER_SHOTS'];
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

async function openScroll(page: Page, viewport: { width: number; height: number }) {
  const served = await encounterFixture(page, 'scroll', {
    viewport,
    scrollDocument: seasons as unknown as Record<string, unknown>,
  });
  await page.goto('/explore');
  await expect(page.getByRole('heading', { level: 1, name: 'CI encounter fixture 1' })).toBeVisible();
  await page.getByRole('button', { name: 'Got it' }).click();
  return served;
}

/** Selects the words of one stop the way a drag across them does, and tells the page the selection changed. */
async function select(page: Page, stopId: string, words: string) {
  await page.evaluate(
    ({ stop, wanted }) => {
      const root = document.querySelector(`[data-ks-stop="${stop}"]`);
      if (root === null) throw new Error(`no stop ${stop}`);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const at = node.textContent?.indexOf(wanted) ?? -1;
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + wanted.length);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        return;
      }
      throw new Error(`no words "${wanted}" in ${stop}`);
    },
    { stop: stopId, wanted: words },
  );
}

for (const viewport of [phone, desktop]) {
  const size = `${String(viewport.width)} × ${String(viewport.height)}`;
  const name = `${String(viewport.width)}x${String(viewport.height)}`;

  test(`Simpler swaps the stop for its own plainer words in place, names them, and Undo brings the text back, at ${size}`, async ({
    page,
  }) => {
    await openScroll(page, viewport);
    const stop = page.locator(`[data-ks-stop="${first.id}"]`);
    await expect(stop.getByText('It leans.')).toBeVisible();
    await stop.getByRole('button', { name: 'Say it simpler' }).click();
    await expect(stop.getByText(first.simple)).toBeVisible();
    await expect(stop.getByText('It leans.')).toHaveCount(0);
    await expect(stop.getByText('SIMPLER VERSION')).toBeVisible();
    await shot(page, `simpler-${name}`);
    expect(await audit(page)).toEqual([]);
    await stop.getByRole('button', { name: 'Undo simpler version' }).click();
    await expect(stop.getByText('It leans.')).toBeVisible();
    await expect(stop.getByText('SIMPLER VERSION')).toHaveCount(0);
    // The ••• menu does the same for the stop on screen.
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('button', { name: 'Simpler (this screen)' }).click();
    await expect(stop.getByText(first.simple)).toBeVisible();
  });

  test(`selecting words offers Simpler and Ask; Ask puts a Quick answer under the stop and asks for no Scroll, at ${size}`, async ({
    page,
  }) => {
    const served = await openScroll(page, viewport);
    await select(page, first.id, 'Earth');
    const menu = page.getByRole('toolbar', { name: 'Selected text' });
    await expect(menu.getByRole('button')).toHaveText(['Simpler', 'Ask']);
    await shot(page, `selection-menu-${name}`);
    await menu.getByRole('button', { name: 'Ask' }).click();
    const card = page.locator(`[data-ks-stop="${first.id}"]`).getByTestId('quick-answer-card');
    await expect(card).toBeVisible();
    await expect(card.getByTestId('quick-answer-label')).toHaveText('QUICK ANSWER · NOT A CHECKED SCROLL');
    // Nothing asked for a Scroll: a Quick answer is its own, capped request (D-253).
    expect(served.commands.filter((command) => command.path === '/v1/content/requests')).toEqual([]);
    expect(served.commands.filter((command) => command.path === '/v1/quick-answers')).toHaveLength(1);
  });

  test(`words of a call are never offered Simpler or Ask, at ${size}`, async ({ page }) => {
    await openScroll(page, viewport);
    await page.getByRole('button', { name: 'Call it 1 of 3', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Call it 1 of 3' })).toBeVisible();
    await select(page, 'call-delhi', 'Delhi');
    await page.waitForTimeout(200);
    await expect(page.getByRole('toolbar', { name: 'Selected text' })).toHaveCount(0);
  });
}

const intents = (commands: { path: string; body: Record<string, unknown> }[]) =>
  commands.filter((call) => call.path === '/v1/experience/navigate').map((call) => call.body['intent']);

test('a Reel on a phone has Your Universe at the left and Next topic at the right, and both work', async ({ page }) => {
  const { commands } = await encounterFixture(page, 'reel', { viewport: phone, series: true });
  await page.route('**/media/gesture-fixture', (route) =>
    route.fulfill({ status: 200, contentType: 'video/webm', body: playableVideo }),
  );
  await page.goto('/explore');
  await expect(page.getByTestId('encounter-reel-caption')).toBeVisible();
  const universe = page.getByRole('button', { name: 'Your Universe' });
  const next = page.getByRole('button', { name: 'Next topic' });
  await expect(universe).toBeVisible();
  await expect(next).toBeVisible();
  // The same places as the Scroll's bar: Universe first, Next last, and the format switch and ••• between them.
  const [u, n, more, reel] = await Promise.all([
    universe.boundingBox(),
    next.boundingBox(),
    page.getByRole('button', { name: 'More options' }).boundingBox(),
    page.getByRole('radio', { name: /^Reel/ }).boundingBox(),
  ]);
  expect(u!.x).toBeLessThan(more!.x);
  expect(n!.x).toBeGreaterThan(reel!.x);
  expect(u!.width).toBeGreaterThanOrEqual(44);
  expect(n!.width).toBeGreaterThanOrEqual(44);
  await shot(page, 'reel-top-bar-390x844');
  expect(await audit(page)).toEqual([]);
  await next.click();
  await expect.poll(() => intents(commands).at(-1)).toMatchObject({ mode: 'vertical', direction: 'next' });
  await page.getByRole('button', { name: 'Your Universe' }).click();
  await expect(page).toHaveURL(/\/universe/);
});

test('the Reel top bar fits a 320 px phone without clipping a control', async ({ page }) => {
  await encounterFixture(page, 'reel', { viewport: small });
  await page.route('**/media/gesture-fixture', (route) =>
    route.fulfill({ status: 200, contentType: 'video/webm', body: playableVideo }),
  );
  await page.goto('/explore');
  await expect(page.getByTestId('encounter-reel-caption')).toBeVisible();
  for (const control of [
    page.getByRole('button', { name: 'Your Universe' }),
    page.getByRole('button', { name: 'More options' }),
    page.getByRole('button', { name: 'Next topic' }),
  ]) {
    const box = await control.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(small.width);
  }
  await shot(page, 'reel-top-bar-320x640');
});

test('a desktop Reel card has Your Universe beside Previous subject, and Next subject below', async ({ page }) => {
  const { commands } = await encounterFixture(page, 'reel', { viewport: desktop, series: true });
  await page.route('**/media/gesture-fixture', (route) =>
    route.fulfill({ status: 200, contentType: 'video/webm', body: playableVideo }),
  );
  await page.goto('/explore');
  await expect(page.getByTestId('explore-desktop-frame')).toBeVisible();
  const frame = page.getByTestId('explore-desktop-frame');
  // The fixture label is drawn once on the desktop card, not in the top row and again on the caption.
  await expect(page.getByText('Fixture video')).toHaveCount(1);
  const universe = frame.getByRole('button', { name: 'Your Universe' });
  await expect(universe).toBeVisible();
  const [u, previous] = await Promise.all([
    universe.boundingBox(),
    frame.getByRole('button', { name: 'Previous subject' }).boundingBox(),
  ]);
  expect(u!.x).toBeLessThan(previous!.x);
  await shot(page, 'reel-top-bar-1440x900');
  expect(await audit(page)).toEqual([]);
  await frame.getByRole('button', { name: 'Next subject' }).click();
  await expect.poll(() => intents(commands).at(-1)).toMatchObject({ mode: 'vertical', direction: 'next' });
  await universe.click();
  await expect(page).toHaveURL(/\/universe/);
});
