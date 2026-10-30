import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { InteractionEventSchema } from '@knowscroll/contracts';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import { stopWords, WORDS_PER_MINUTE_V2, type ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { encounterFixture } from './encounter-fixture';

/**
 * The Stage + Spine reader of a v2 Scroll in the production export (D-133, D-134, D-135). The
 * document is the labelled CI fixture `seasons-stage-ci` (not product content) served by authored
 * HTTP fixtures, so this proves the reader and what it reports, not the backend.
 */

const fixture = seasons as unknown as ScrollDocumentV2;
const phone = { width: 390, height: 844 };
const desktop = { width: 1440, height: 900 };

/** The server's rule for a read stop (D-128): 40 % of the time its own words take, and never under half a second. */
const minVisibleMs = (words: number): number =>
  Math.max(500, Math.round(((words * 60_000) / WORDS_PER_MINUTE_V2) * 0.4));

const readStops = fixture.stops.filter((stop) => stop.kind === 'read');
const calls = fixture.stops.filter((stop) => stop.kind !== 'read');

async function open(page: Page, viewport = phone) {
  const served = await encounterFixture(page, 'scroll', {
    series: true,
    viewport,
    scrollDocument: seasons as unknown as Record<string, unknown>,
  });
  await page.goto('/explore');
  await expect(page.getByRole('heading', { level: 1, name: 'CI encounter fixture 1' })).toBeVisible();
  await page.getByRole('button', { name: 'Got it' }).click();
  return served;
}

/** The name of the dot for a stop: what the spine calls it. */
const dotName = (index: number): string => {
  const stop = fixture.stops[index];
  if (stop === undefined) throw new Error('no such stop');
  if (stop.kind === 'read') return `Stop ${String(index + 1)} of ${String(fixture.stops.length)}`;
  if (stop.kind === 'final_call') return 'Final call';
  return `Call it ${String(calls.indexOf(stop) + 1)} of ${String(calls.length)}`;
};

const stage = (page: Page) => page.getByTestId('stage');
const reader = (page: Page) => page.getByRole('group', { name: 'Scroll reader' });
const here = (page: Page, name: string) => page.getByRole('button', { name: `${name}, you are here` });
const navigations = (commands: { path: string; body: Record<string, unknown> }[]) =>
  commands.filter((call) => call.path === '/v1/experience/navigate').map((call) => call.body.intent);

/** Records every value the stage's transition attribute takes, so a short tween is not missed. */
async function recordTransitions(page: Page) {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __transitions: string[] }).__transitions = seen;
    const node = document.querySelector('[data-testid="stage"]');
    if (node === null) throw new Error('the stage is on the page');
    new MutationObserver(() => seen.push(node.getAttribute('data-ks-stage-transition') ?? '')).observe(node, {
      attributes: true,
      attributeFilter: ['data-ks-stage-transition'],
    });
  });
  return () => page.evaluate(() => (window as unknown as { __transitions: string[] }).__transitions);
}

test('the picture changes as the reader moves from stop to stop, and it is named for a screen reader', async ({
  page,
}) => {
  await open(page);
  await expect(stage(page)).toHaveAttribute('data-ks-stage-state', 'the-lean');
  await expect(page.getByRole('img', { name: /The Sun is on the left and Earth is on the right/ })).toBeVisible();
  await reader(page).focus();
  for (const key of ['ArrowDown', 'ArrowDown', 'ArrowDown']) await page.keyboard.press(key);
  await expect(stage(page)).toHaveAttribute('data-ks-stage-state', 'closest-in-january');
  await expect(
    page.getByRole('img', { name: /orbit stretched so that the nearest and farthest points show/ }),
  ).toBeVisible();
  await expect(here(page, 'Stop 4 of 12')).toBeVisible();
  // Up again returns to the earlier picture: the stage follows the stop, not the direction.
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(stage(page)).toHaveAttribute('data-ks-stage-state', 'same-direction');
});

test('the picture changes as the text scrolls under a mouse wheel', async ({ page }) => {
  await open(page);
  const scroller = page.getByTestId('stop-scroller');
  await scroller.hover();
  await expect(stage(page)).toHaveAttribute('data-ks-stage-state', 'the-lean');
  await expect(async () => {
    await page.mouse.wheel(0, 500);
    await expect(stage(page)).not.toHaveAttribute('data-ks-stage-state', 'the-lean', { timeout: 500 });
  }).toPass({ timeout: 10_000 });
});

test('a tap on a dot jumps to that stop, and the dot says where you are', async ({ page }) => {
  await open(page);
  await expect(here(page, 'Stop 1 of 12')).toBeVisible();
  await page.getByRole('button', { name: 'Stop 9 of 12', exact: true }).click();
  await expect(here(page, 'Stop 9 of 12')).toBeVisible();
  await expect(stage(page)).toHaveAttribute('data-ks-stage-state', 'equinox');
  await page.getByRole('button', { name: 'The end of this Scroll', exact: true }).click();
  await expect(here(page, 'The end of this Scroll')).toBeVisible();
  await expect(page.getByTestId('end-tray')).toBeVisible();
});

test('Part 2 is a button, a key and a swipe, and the Scroll that follows has its own stage', async ({ page }) => {
  const { commands } = await open(page);
  await page.getByRole('button', { name: 'Part 2', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'CI encounter fixture 2' })).toBeVisible();
  await expect(stage(page)).toHaveAttribute('data-ks-stage-state', 'the-lean');
  expect(navigations(commands).at(-1)).toMatchObject({ mode: 'series', direction: 'next' });

  // The key.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const before = navigations(commands).length;
  await reader(page).focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => navigations(commands).length).toBe(before + 1);
  expect(navigations(commands).at(-1)).toMatchObject({ mode: 'series', direction: 'next' });
});

test('a swipe left on the text goes to Part 2, a swipe right goes back, and the stage keeps its own drags', async ({
  page,
}) => {
  const { commands } = await open(page);
  const text = await page.getByTestId('stop-scroller').boundingBox();
  const picture = await stage(page).boundingBox();
  if (text === null || picture === null) throw new Error('the text and the stage are on the page');
  const drag = async (box: { x: number; y: number; width: number; height: number }, from: number, to: number) => {
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * from, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * ((from + to) / 2), y + 6, { steps: 4 });
    await page.mouse.move(box.x + box.width * to, y + 8, { steps: 4 });
    await page.mouse.up();
  };

  // On the stage a sideways drag is the picture's own: it moves nothing.
  await drag(picture, 0.8, 0.2);
  await page.waitForTimeout(300);
  expect(navigations(commands)).toEqual([]);

  // A short, slow-looking nudge on the text is not a swipe either.
  await drag(text, 0.6, 0.5);
  await page.waitForTimeout(300);
  expect(navigations(commands)).toEqual([]);

  await drag(text, 0.85, 0.15);
  await expect.poll(() => navigations(commands).length).toBe(1);
  expect(navigations(commands)[0]).toMatchObject({ mode: 'series', direction: 'next' });
  await expect(page.getByRole('heading', { level: 1, name: 'CI encounter fixture 2' })).toBeVisible();
});

test('a new topic is Next, the N key and a pull up past the end, never reading', async ({ page }) => {
  const { commands } = await open(page);
  await page.getByRole('button', { name: 'Next topic', exact: true }).click();
  await expect.poll(() => navigations(commands).length).toBe(1);
  expect(navigations(commands)[0]).toMatchObject({ mode: 'vertical', direction: 'next' });
  await expect(page.getByRole('heading', { level: 1, name: 'CI encounter fixture 2' })).toBeVisible();

  await reader(page).focus();
  await page.keyboard.press('n');
  await expect.poll(() => navigations(commands).length).toBe(2);
  expect(navigations(commands)[1]).toMatchObject({ mode: 'vertical', direction: 'next' });
  await expect(page.getByRole('heading', { level: 1, name: 'CI encounter fixture 3' })).toBeVisible();

  // A pull up in the middle of the text is reading: the text scrolls and nothing navigates.
  const text = await page.getByTestId('stop-scroller').boundingBox();
  if (text === null) throw new Error('the text is on the page');
  const x = text.x + text.width / 2;
  const pull = async (from: number, to: number) => {
    await page.mouse.move(x, text.y + text.height * from);
    await page.mouse.down();
    await page.mouse.move(x, text.y + text.height * ((from + to) / 2), { steps: 5 });
    await page.mouse.move(x, text.y + text.height * to, { steps: 5 });
    await page.mouse.up();
  };
  await pull(0.9, 0.1);
  await page.waitForTimeout(300);
  expect(navigations(commands)).toHaveLength(2);

  // At the end, the same pull is a deliberate ask for something new.
  await page.getByRole('button', { name: 'The end of this Scroll', exact: true }).click();
  await expect(here(page, 'The end of this Scroll')).toBeVisible();
  const scroller = page.getByTestId('stop-scroller');
  // (React Native Web gives the scroll node its own `scrollTo({ x, y })`, so the DOM property is set directly.)
  await scroller.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect
    .poll(() => scroller.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight))
    .toBeLessThan(4);
  await pull(0.95, 0.05);
  await expect.poll(() => navigations(commands).length).toBe(3);
  expect(navigations(commands)[2]).toMatchObject({ mode: 'vertical', direction: 'next' });
});

test('the same view moves between states (a tween); a different view fades', async ({ page }) => {
  await open(page);
  const seen = await recordTransitions(page);
  await reader(page).focus();
  await page.keyboard.press('ArrowDown');
  await expect(stage(page)).toHaveAttribute('data-ks-stage-state', 'same-direction');
  // Sun and Earth to the orbit is a different picture: it fades.
  await expect.poll(async () => (await seen()).includes('crossfade')).toBe(true);
  expect(await seen()).not.toContain('tween');
  // Let the fade finish: a move that starts while another is under way starts from the picture on screen.
  await page.waitForTimeout(500);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(stage(page)).toHaveAttribute('data-ks-stage-state', 'closest-in-january');
  // The orbit to the stretched orbit is the same picture changing: Earth glides and the orbit flattens.
  await expect.poll(async () => (await seen()).includes('tween')).toBe(true);
});

test('under reduced motion the picture cross-fades and never tweens', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  const seen = await recordTransitions(page);
  await reader(page).focus();
  for (let step = 0; step < 3; step += 1) await page.keyboard.press('ArrowDown');
  await expect(stage(page)).toHaveAttribute('data-ks-stage-state', 'closest-in-january');
  await expect.poll(async () => (await seen()).includes('crossfade')).toBe(true);
  expect(await seen()).not.toContain('tween');
});

test('a call is played on the device: pick, lock in, the answer and the Plot twist; keys do the same', async ({
  page,
}) => {
  await page.clock.install();
  const { observed } = await open(page);
  await page.getByRole('button', { name: 'Call it 1 of 3', exact: true }).click();
  const lock = page.getByRole('group', { name: 'Call it 1 of 3' }).getByRole('button', { name: 'Lock it in' });
  await expect(lock).toBeDisabled();
  await expect(page.getByText('Plot twist!')).toHaveCount(0);
  await page.getByRole('radio', { name: /Earth is closer to the Sun in June/ }).click();
  await lock.click();
  await expect(page.getByText('Plot twist!')).toBeVisible();
  await expect(page.getByText(/The common guess\. Source: A Private Universe/)).toBeVisible();
  await expect(page.getByRole('radio', { name: /Earth is closer/ })).toBeDisabled();
  // The reveal is reported by kind, never by the option that was picked.
  await flushObservations(page);
  expect(reported(observed)).toContain('revealed');
  for (const event of observed.filter((entry) => entry.kind === 'scroll.block_interaction'))
    expect(Object.keys(event.payload).sort()).toEqual(['atMs', 'blockId', 'kind']);

  await page.getByRole('button', { name: 'Call it 2 of 3', exact: true }).click();
  await reader(page).focus();
  await page.keyboard.press('2');
  await expect(page.getByRole('radio', { name: /The southern half/ })).toBeChecked();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Plot twist!')).toHaveCount(1);
});

const reported = (observed: { kind: string; payload: Record<string, unknown> }[]): string[] =>
  observed.filter((event) => event.kind === 'scroll.block_interaction').map((event) => String(event.payload.kind));

/** Visible time per block, in ms, from every coverage event the page sent. */
function visibleMs(observed: { kind: string; payload: Record<string, unknown> }[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const event of observed) {
    if (event.kind !== 'scroll.block_coverage') continue;
    const blocks = event.payload.blocks as { blockId: string; intervalsMs: [number, number][] }[];
    for (const block of blocks)
      totals.set(
        block.blockId,
        (totals.get(block.blockId) ?? 0) + block.intervalsMs.reduce((sum, [from, to]) => sum + (to - from), 0),
      );
  }
  return totals;
}

async function flushObservations(page: Page) {
  // The recorder reports every 15 s while it has something to say.
  await page.clock.fastForward(16_000);
  await page.waitForTimeout(200);
}

test('reading all of Part 1 produces the facts that qualify it: every stop for its own reading time, every call revealed', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  const { observed } = await open(page);

  // Read it through: each read stop for the time its own words take at 230 words a minute, each call revealed.
  await reader(page).focus();
  for (const [index, stop] of fixture.stops.entries()) {
    // The stop is on screen before the time passes, as it is for a person who has scrolled to it.
    await expect(page.getByRole('button', { name: new RegExp(`^${dotName(index)}, you are here`) })).toBeVisible();
    if (stop.kind === 'read') {
      await page.clock.fastForward(Math.round(((stopWords(stop) * 60_000) / WORDS_PER_MINUTE_V2) * 0.5) + 300);
    } else {
      await page.keyboard.press('1');
      await page.keyboard.press('Enter');
    }
    await page.keyboard.press('ArrowDown');
  }
  await flushObservations(page);
  expect(observed.length).toBeGreaterThan(0);
  const read = visibleMs(observed);
  for (const stop of readStops)
    expect(read.get(stop.id) ?? 0, `read stop ${stop.id}`).toBeGreaterThanOrEqual(minVisibleMs(stopWords(stop)));
  expect(reported(observed).sort()).toEqual(calls.map(() => 'revealed'));
  // Every event is one the server's intake schema accepts, so the facts above are what it would store.
  for (const event of observed)
    InteractionEventSchema.parse({ ...envelope(), kind: event.kind, payload: event.payload });
});

test('tapping through every dot without dwelling does not read the Scroll', async ({ page }) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  const { observed } = await open(page);
  for (let index = 1; index <= fixture.stops.length; index += 1) {
    await page
      .getByRole('button', { name: /^(Stop|Call it|Final call)/ })
      .nth(index - 1)
      .click();
    await page.clock.fastForward(250);
  }
  await page.getByRole('button', { name: 'The end of this Scroll', exact: true }).click();
  await flushObservations(page);
  const read = visibleMs(observed);
  for (const stop of readStops)
    expect(read.get(stop.id) ?? 0, `read stop ${stop.id}`).toBeLessThan(minVisibleMs(stopWords(stop)));
  expect(reported(observed)).toEqual([]);
});

/** The envelope fields the recorder adds to each event, so a bare payload can be checked against the intake schema. */
function envelope() {
  const uuid = '0199a000-0000-7000-8000-000000000001';
  return {
    schemaVersion: 'interaction.v1',
    eventId: uuid,
    sessionId: uuid,
    deviceSequence: 1,
    exposureId: uuid,
    assetId: '0199a000-0000-7000-8000-000000000002',
    assetRevision: 1,
    occurredAt: '2026-10-30T09:00:00.000Z',
  };
}

test.describe('accessibility (axe) of the reader', () => {
  for (const viewport of [phone, desktop]) {
    test(`no serious violations at ${String(viewport.width)} × ${String(viewport.height)}, with an aside open, a call revealed and the ••• sheet`, async ({
      page,
    }) => {
      await open(page, viewport);
      const audit = async () => {
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
          .analyze();
        return results.violations
          .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
          .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(' | ')}`);
      };
      expect(await audit()).toEqual([]);
      await page.getByRole('button', { name: 'Call it 1 of 3', exact: true }).click();
      await page.getByRole('radio', { name: /Delhi’s half/ }).click();
      await page.getByRole('group', { name: 'Call it 1 of 3' }).getByRole('button', { name: 'Lock it in' }).click();
      await page.getByRole('button', { name: 'Stop 11 of 12', exact: true }).click();
      await page.getByRole('button', { name: /^Small print: Where this stops/ }).click();
      await expect(page.getByText(/Light sets the season/)).toBeVisible();
      expect(await audit()).toEqual([]);
      await page.getByRole('button', { name: 'The end of this Scroll', exact: true }).click();
      expect(await audit()).toEqual([]);
      await page.getByRole('button', { name: 'Text version' }).click();
      expect(await audit()).toEqual([]);
      await page.getByRole('button', { name: 'More', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'More', exact: true })).toBeVisible();
      await page.waitForTimeout(400);
      expect(await audit()).toEqual([]);
    });
  }
});
