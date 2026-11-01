import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import { encounterFixture, id, type EncounterFixtureOptions } from './encounter-fixture';

/**
 * Ask from here (D1, D-218) in the production export: the sheet over a Scroll that has stops, the questions the Scroll
 * itself suggests, the honest wait with its puzzle, the typical time only when one was measured, the ready and
 * could-not-prepare states (E07), and an ask that is off while recording is paused. The document is the labelled CI
 * fixture `seasons-stage-ci` and the request routes are authored HTTP fixtures, so this proves what the screen sends
 * and shows, not what the server decides (`tests/integration/modules/supply-ask.test.ts` is the backend).
 */
const phone = { width: 390, height: 844 };
const desktop = { width: 1440, height: 900 };
const suggestions = seasons.askSuggestions;

async function open(page: Page, viewport = phone, options: Pick<EncounterFixtureOptions, 'requests' | 'play'> = {}) {
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

const askButton = (page: Page) => page.getByRole('button', { name: /^Ask/ }).first();
const asked = (served: Awaited<ReturnType<typeof open>>) =>
  served.commands.filter((command) => command.path === '/v1/content/requests');

async function audit(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(' | ')}`);
}

for (const viewport of [phone, desktop]) {
  const size = `${String(viewport.width)} × ${String(viewport.height)}`;

  test(`on a Scroll's own address the dock offers the same Ask, sourced from that Scroll's exposure with no session, at ${size}`, async ({
    page,
  }) => {
    const served = await encounterFixture(page, 'scroll', {
      viewport,
      direct: { parts: 1 },
      scrollDocument: seasons as unknown as Record<string, unknown>,
    });
    await page.goto(`/scroll/${id(300)}`);
    await expect(page.getByTestId('scroll-reader')).toBeVisible();
    await askButton(page).click();
    const sheet = page.getByRole('dialog', { name: 'Ask' });
    await expect(sheet.getByRole('heading', { name: 'Ask' })).toBeVisible();
    await expect(sheet.getByText('FROM WHAT YOU JUST READ')).toBeVisible();
    expect(asked(served)).toEqual([]);
    await sheet.getByRole('button', { name: `Ask: ${suggestions[0]}` }).click();
    await expect(page.getByTestId('ask-making')).toBeVisible();
    expect(asked(served)).toHaveLength(1);
    const { intent } = asked(served)[0]!.body as { intent: { kind: string; source: Record<string, unknown> } };
    expect(intent.kind).toBe('ask');
    // A Scroll opened by its address has no experience session to name.
    expect(Object.keys(intent.source).sort()).toEqual(['assetId', 'assetRevision', 'exposureId']);
    expect(await audit(page)).toEqual([]);
    // Closing the sheet leaves the reader with a quiet note that the answer is on its way.
    await page.getByTestId('ask-making').getByRole('button', { name: 'Keep reading' }).click();
    await expect(sheet).toHaveCount(0);
    await expect(page.getByText("We'll let you know when your answer is ready")).toBeVisible();
  });

  test(`the sheet starts from what was just read, says what will be made and sends nothing yet, at ${size}`, async ({
    page,
  }) => {
    const served = await open(page, viewport);
    await askButton(page).click();
    const sheet = page.getByRole('dialog', { name: 'Ask for something' });
    await expect(sheet.getByRole('heading', { name: 'Ask' })).toBeVisible();
    await expect(sheet.getByText('FROM WHAT YOU JUST READ')).toBeVisible();
    for (const question of suggestions)
      await expect(sheet.getByRole('button', { name: `Ask: ${question}` })).toBeVisible();
    await expect(sheet.getByText('OR ASK ANYTHING')).toBeVisible();
    // One editable line says what will be made; nothing to pick before typing, and no counter until near the limit.
    await expect(sheet.getByText(/A short Scroll · about “CI encounter fixture 1”/)).toBeVisible();
    await expect(sheet.getByText(/\/280/)).toHaveCount(0);
    await expect(sheet.getByRole('button', { name: 'Send' })).toBeDisabled();
    // Nothing of the machinery reaches the screen.
    await expect(sheet.getByText(/prompt|model|score|sources?\b/i)).toHaveCount(0);
    expect(asked(served)).toEqual([]);
    expect(await audit(page)).toEqual([]);
  });

  test(`a tap on a suggested question sends it, anchored to a stop, and the wait is honest, at ${size}`, async ({
    page,
  }) => {
    const served = await open(page, viewport);
    await askButton(page).click();
    await page.getByRole('button', { name: `Ask: ${suggestions[0]}` }).click();

    const making = page.getByTestId('ask-making');
    await expect(making.getByText('Making it now')).toBeVisible();
    await expect(making).toContainText(suggestions[0]!);
    // No typical time was measured: none is claimed.
    await expect(making).not.toContainText('usually');
    await expect(making.getByRole('button', { name: 'Keep reading' })).toBeVisible();
    await expect(making.getByRole('button', { name: 'Cancel' })).toBeVisible();

    expect(asked(served)).toHaveLength(1);
    const body = asked(served)[0]!.body as {
      intent: {
        kind: string;
        question: string;
        anchor: { kind: string; stopId: string };
        source: Record<string, unknown>;
      };
      recordingGeneration?: number;
    };
    expect(body.intent).toMatchObject({
      kind: 'ask',
      question: suggestions[0],
      anchor: { kind: 'stop' },
      recordingGeneration: 1,
    });
    expect(seasons.stops.map((stop) => stop.id)).toContain(body.intent.anchor.stopId);
    // The request names the exact Scroll revision it was asked from, and carries no answer, score or format.
    expect(Object.keys(body.intent.source).sort()).toEqual(['assetId', 'assetRevision', 'exposureId', 'session']);
    expect(JSON.stringify(body)).not.toMatch(/format|score/i);
    expect(await audit(page)).toEqual([]);
  });
}

test('the puzzle is one of the Scroll’s own calls, played in place: a right pick is a spark, a wrong pick a Plot twist', async ({
  page,
}) => {
  const served = await open(page);
  await askButton(page).click();
  await page.getByRole('button', { name: `Ask: ${suggestions[1]}` }).click();
  const puzzle = page.getByTestId('ask-puzzle');
  await expect(puzzle.getByText('MEANWHILE · 20-SECOND PUZZLE')).toBeVisible();
  await expect(puzzle.getByRole('radio')).toHaveCount(3);
  await puzzle.getByRole('radio').nth(1).click();
  await expect(page.getByTestId('ask-puzzle-reveal')).toBeVisible();
  // A pick is judged by the play layer from the revision, as in the reader: only the lock is sent.
  await expect.poll(() => served.commands.filter((command) => command.path === '/v1/play/calls/lock').length).toBe(1);
  const lock = served.commands.find((command) => command.path === '/v1/play/calls/lock')!;
  expect(Object.keys(lock.body).sort()).toEqual([
    'assetId',
    'commandId',
    'option',
    'recordingGeneration',
    'revision',
    'stopId',
  ]);
  // The ask itself is not play and not reading: only the one lock the person made.
  expect(served.observed.filter((event) => event.kind === 'interaction')).toEqual([]);
  await expect(puzzle.getByRole('radio').first()).toBeDisabled();
});

test('a typical time appears only when the server measured one', async ({ page }) => {
  await open(page, phone, { requests: { typicalSeconds: 150 } });
  await askButton(page).click();
  await page.getByRole('button', { name: `Ask: ${suggestions[0]}` }).click();
  await expect(page.getByTestId('ask-making')).toContainText(
    "We'll let you know here when it's ready, usually about 3 min.",
  );
});

test('typing a question and sending it works, with the counter only near the limit', async ({ page }) => {
  const served = await open(page);
  await askButton(page).click();
  const sheet = page.getByRole('dialog', { name: 'Ask for something' });
  const input = sheet.getByRole('textbox', { name: 'Ask a question' });
  await input.fill('Why does the far side of the planet stay cold in its summer?');
  await expect(sheet.getByText(/\/280/)).toHaveCount(0);
  await input.fill(`${'Why is it so? '.repeat(19)}`);
  await expect(sheet.getByText(/\d+\/280/)).toBeVisible();
  await input.fill('Why does the far side of the planet stay cold in its summer?');
  await sheet.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByTestId('ask-making')).toBeVisible();
  expect(asked(served)[0]!.body).toMatchObject({
    intent: { kind: 'ask', question: 'Why does the far side of the planet stay cold in its summer?' },
  });
});

test('Change asks about something new: the words go as a free-text ask with no source', async ({ page }) => {
  const served = await open(page);
  await askButton(page).click();
  const sheet = page.getByRole('dialog', { name: 'Ask for something' });
  await sheet.getByRole('button', { name: 'Change: ask about something new' }).click();
  await expect(sheet.getByText('A short Scroll · about something new')).toBeVisible();
  await sheet.getByRole('textbox', { name: 'Ask a question' }).fill('How do tides work?');
  await sheet.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByTestId('ask-making')).toBeVisible();
  const body = asked(served)[0]!.body as { intent: Record<string, unknown> };
  expect(body.intent).toMatchObject({
    kind: 'topic',
    subject: { kind: 'text', text: 'How do tides work?' },
    format: 'scroll',
  });
  expect(body.intent).not.toHaveProperty('context');
});

test('the keys of D1: 1 picks a suggested question, Esc closes', async ({ page }) => {
  const served = await open(page, desktop);
  // The reader's keys act while the reader has focus (D-134).
  await page.getByTestId('scroll-reader').focus();
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Ask for something' })).toBeVisible();
  await page.keyboard.press('2');
  await expect(page.getByTestId('ask-making')).toBeVisible();
  expect(asked(served)[0]!.body).toMatchObject({ intent: { kind: 'ask', question: suggestions[1] } });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Ask for something' })).toHaveCount(0);
});

test('a ready answer opens from the sheet, and a close that was not final keeps the request', async ({ page }) => {
  await open(page, phone, { requests: { outcome: 'ready' } });
  await askButton(page).click();
  await page.getByRole('button', { name: `Ask: ${suggestions[0]}` }).click();
  const ready = page.getByTestId('ask-ready');
  await expect(ready.getByText('Why the far side stays cold')).toBeVisible();
  await expect(ready.getByRole('button', { name: 'Open your Scroll' })).toBeVisible();
});

test('could not prepare is said plainly, and Try again re-drives the same request', async ({ page }) => {
  const served = await open(page, phone, { requests: { outcome: 'could_not_prepare' } });
  await askButton(page).click();
  await page.getByRole('button', { name: `Ask: ${suggestions[0]}` }).click();
  const closed = page.getByTestId('ask-closed');
  await expect(closed.getByRole('heading', { name: "We couldn't prepare this one" })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ask differently' })).toBeVisible();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect
    .poll(() => served.commands.filter((command) => command.path === '/v1/content/requests/retry').length)
    .toBe(1);
  // The same request goes again: no second ask was made.
  expect(asked(served)).toHaveLength(1);
  await expect(page.getByTestId('ask-making')).toBeVisible();
});

test('while recording is paused the ask is off, says why, and sends nothing', async ({ page }) => {
  const served = await open(page, phone, { play: { recordingPaused: true } });
  await askButton(page).click();
  const sheet = page.getByRole('dialog', { name: 'Ask for something' });
  await expect(sheet.getByTestId('ask-paused')).toContainText('off while recording is paused');
  await expect(sheet.getByRole('button', { name: `Ask: ${suggestions[0]}` })).toBeDisabled();
  await expect(sheet.getByRole('button', { name: 'Send' })).toBeDisabled();
  expect(asked(served)).toEqual([]);
  expect(await audit(page)).toEqual([]);
});
