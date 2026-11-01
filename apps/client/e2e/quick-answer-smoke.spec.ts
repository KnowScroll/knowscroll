import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import { encounterFixture, type EncounterFixtureOptions } from './encounter-fixture';

/**
 * Quick answer (V3 D2, D-086, D-253) in the production export over labelled HTTP fixtures: select words in a read stop and
 * choose Ask, and a card under the stop says "Quick answer · not a checked Scroll", answers once the worker has, offers
 * "Make it a full Scroll" (Ask from here), a follow-up, Report (the content-error form, carrying the answer's ID) and Close
 * (which erases its words). An honest "not available" when the day is used up, nothing sent while recording is paused. The
 * answers are authored here, so this proves what the screen sends and shows, not what a model says
 * (`tests/integration/modules/quick-answers.test.ts` is the backend). Screenshots are written only when
 * `KS_QUICK_SHOTS` names a folder (outside the repository).
 */
const phone = { width: 390, height: 844 };
const desktop = { width: 1440, height: 900 };
const first = seasons.stops[0] as { id: string };

async function shot(page: Page, name: string) {
  const folder = process.env['KS_QUICK_SHOTS'];
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

async function open(
  page: Page,
  viewport = phone,
  options: Pick<EncounterFixtureOptions, 'quickAnswers' | 'play'> = {},
) {
  const served = await encounterFixture(page, 'scroll', {
    series: true,
    viewport,
    scrollDocument: seasons as unknown as Record<string, unknown>,
    ...options,
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

async function ask(page: Page, words = 'Earth') {
  await select(page, first.id, words);
  await page.getByRole('toolbar', { name: 'Selected text' }).getByRole('button', { name: 'Ask' }).click();
  return page.locator(`[data-ks-stop="${first.id}"]`).getByTestId('quick-answer-card');
}

const quickCommands = (served: Awaited<ReturnType<typeof open>>, path = '/v1/quick-answers') =>
  served.commands.filter((command) => command.path === path);

for (const viewport of [phone, desktop]) {
  const size = `${String(viewport.width)} × ${String(viewport.height)}`;
  const name = `${String(viewport.width)}x${String(viewport.height)}`;

  test(`Ask on selected words shows a labelled Quick answer under the stop once it is answered, with the way to a full Scroll, at ${size}`, async ({
    page,
  }) => {
    const served = await open(page, viewport);
    const card = await ask(page);
    await expect(card.getByTestId('quick-answer-label')).toHaveText('QUICK ANSWER · NOT A CHECKED SCROLL');
    await expect(card.getByTestId('quick-answer-working')).toBeVisible();
    await shot(page, `quick-answer-working-${name}`);
    // The words are sent for the stop they were selected in, at the revision on screen, and nothing else.
    expect(quickCommands(served)).toHaveLength(1);
    expect(quickCommands(served)[0]!.body).toMatchObject({
      version: 'quick-answer-ask.v1',
      stopId: first.id,
      passage: 'Earth',
      recordingGeneration: 1,
    });
    expect(quickCommands(served)[0]!.body).not.toHaveProperty('question');
    await expect(card.getByTestId('quick-answer-question')).toHaveText('Why does it keep pointing the same way?', {
      timeout: 15_000,
    });
    await expect(card.getByTestId('quick-answer-answer')).toContainText('Nothing turns the axis');
    await expect(card.getByRole('button', { name: 'Make it a full Scroll' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Report' })).toBeVisible();
    // The reader brings a card that appears or grows under a stop on screen: the person never has to look for it.
    await expect(card).toBeInViewport({ ratio: 1 });
    await shot(page, `quick-answer-${name}`);
    expect(await audit(page)).toEqual([]);
    // Never a Scroll: no request was made for one, and the words are not offered another Ask from inside the card.
    expect(served.commands.filter((command) => command.path === '/v1/content/requests')).toEqual([]);
    await page.evaluate(() => {
      const answer = document.querySelector('[data-testid="quick-answer-answer"]')!;
      const range = document.createRange();
      range.selectNodeContents(answer);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await page.waitForTimeout(200);
    await expect(page.getByRole('toolbar', { name: 'Selected text' })).toHaveCount(0);
  });

  test(`"Make it a full Scroll" opens Ask from here at the stop with the answer's question as the draft, and sends nothing until Send, at ${size}`, async ({
    page,
  }) => {
    const served = await open(page, viewport);
    const card = await ask(page);
    await card.getByRole('button', { name: 'Make it a full Scroll' }).click({ timeout: 15_000 });
    const sheet = page.getByRole('dialog', { name: 'Ask for something' });
    await expect(sheet.getByRole('heading', { name: 'Ask' })).toBeVisible();
    await expect(sheet.getByRole('textbox')).toHaveValue('Why does it keep pointing the same way?');
    await page.waitForTimeout(300);
    expect(served.commands.filter((command) => command.path === '/v1/content/requests')).toEqual([]);
    await shot(page, `make-full-scroll-${name}`);
  });

  test(`Report opens the content-error form and sends the Quick answer's ID with it, at ${size}`, async ({ page }) => {
    const served = await open(page, viewport);
    const card = await ask(page);
    await card.getByRole('button', { name: 'Report' }).click({ timeout: 15_000 });
    const sheet = page.getByRole('dialog', { name: 'Report' });
    await expect(sheet.getByRole('heading', { name: 'Report an error' })).toBeVisible();
    await shot(page, `report-${name}`);
    await sheet.getByRole('button', { name: /^Send/ }).click();
    await expect.poll(() => quickCommands(served, '/v1/feedback/content-errors')).toHaveLength(1);
    expect(quickCommands(served, '/v1/feedback/content-errors')[0]!.body).toMatchObject({
      category: 'wrong',
      anchor: { kind: 'scroll', blockId: first.id },
      quickAnswerId: '0199a000-0000-7000-8000-000000000961',
    });
  });

  test(`Close erases the answer on the server and takes the card away; a follow-up asks about the same words, at ${size}`, async ({
    page,
  }) => {
    const served = await open(page, viewport);
    const card = await ask(page);
    await card.getByRole('button', { name: 'Ask a follow-up' }).click({ timeout: 15_000 });
    await card.getByRole('textbox', { name: 'Your follow-up question' }).fill('And what does that change?');
    await card.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect.poll(() => quickCommands(served)).toHaveLength(2);
    expect(quickCommands(served)[1]!.body).toMatchObject({ passage: 'Earth', question: 'And what does that change?' });
    await expect(card.getByTestId('quick-answer-question')).toHaveText('And what does that change?', {
      timeout: 15_000,
    });
    await card.getByRole('button', { name: 'Close' }).click();
    await expect(card).toHaveCount(0);
    await expect.poll(() => quickCommands(served, '/v1/quick-answers/dismiss')).toHaveLength(1);
  });

  test(`an answer the Scroll does not cover says so, and still offers the full Scroll, at ${size}`, async ({
    page,
  }) => {
    await open(page, viewport, { quickAnswers: { covered: false } });
    const card = await ask(page);
    await expect(card.getByTestId('quick-answer-answer')).toContainText('does not answer that', { timeout: 15_000 });
    await expect(card.getByRole('button', { name: 'Make it a full Scroll' })).toBeVisible();
  });

  test(`the day's limit is an honest "not available", with the full Scroll still a way on, at ${size}`, async ({
    page,
  }) => {
    await open(page, viewport, { quickAnswers: { ask: 'not_available' } });
    const card = await ask(page);
    await expect(card.getByTestId('quick-answer-unavailable')).toHaveText('Quick answers are not available right now.');
    await expect(card.getByRole('button', { name: 'Make it a full Scroll' })).toBeVisible();
    await shot(page, `quick-answer-unavailable-${name}`);
    expect(await audit(page)).toEqual([]);
  });

  test(`a person's own limit says they have used today's, at ${size}`, async ({ page }) => {
    await open(page, viewport, { quickAnswers: { ask: 'person_limit' } });
    const card = await ask(page);
    await expect(card.getByTestId('quick-answer-unavailable')).toContainText('You have used today’s Quick answers');
  });

  test(`a failed answer says so and never shows made-up words, at ${size}`, async ({ page }) => {
    await open(page, viewport, { quickAnswers: { fails: true } });
    const card = await ask(page);
    await expect(card.getByTestId('quick-answer-unavailable')).toHaveText('We couldn’t answer that one.', {
      timeout: 15_000,
    });
    await expect(card.getByTestId('quick-answer-answer')).toHaveCount(0);
  });

  test(`while recording is paused nothing is sent and the card says why, at ${size}`, async ({ page }) => {
    const served = await open(page, viewport, { play: { recordingPaused: true } });
    const card = await ask(page);
    await expect(card.getByTestId('quick-answer-unavailable')).toContainText('off while recording is paused');
    await expect(card.getByRole('button', { name: 'Make it a full Scroll' })).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(quickCommands(served)).toEqual([]);
  });
}
