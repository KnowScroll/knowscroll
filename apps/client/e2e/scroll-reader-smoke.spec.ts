import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { InteractionEventSchema } from '@knowscroll/contracts';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import { stopWords, WORDS_PER_MINUTE_V2, type ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { encounterFixture, readCover } from './encounter-fixture';

/**
 * The Folio reader of a v2 Scroll in the production export, from Explore: the ways between Parts and topics, and what
 * reading reports to the recorder. The document is the labelled CI fixture `seasons-stage-ci` (not product content)
 * served by authored HTTP fixtures, so this proves the reader and what it reports, not the backend.
 */

const fixture = seasons as unknown as ScrollDocumentV2;
const phone = { width: 390, height: 844 };
const desktop = { width: 1440, height: 900 };

/** The server's rule for a read stop (D-128): 40 % of the time its own words take, and never under half a second. */
const minVisibleMs = (words: number): number =>
  Math.max(500, Math.round(((words * 60_000) / WORDS_PER_MINUTE_V2) * 0.4));

const readStops = fixture.stops.filter((stop) => stop.kind === 'read');

async function open(page: Page, viewport = phone) {
  const served = await encounterFixture(page, 'scroll', {
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
  return served;
}

const scroller = (page: Page) => page.getByTestId('folio-scroller');
const reader = (page: Page) => page.getByRole('group', { name: 'Scroll reader' });
/** The Part's own title, in the essay's opening (the top bar repeats it). */
const essayTitle = (page: Page, part: number) =>
  scroller(page).getByRole('heading', { level: 1, name: `CI encounter fixture ${String(part)}` });
const navigations = (commands: { path: string; body: Record<string, unknown> }[]) =>
  commands.filter((call) => call.path === '/v1/experience/navigate').map((call) => call.body.intent);

test('Part 2 is a button and a key, and the Part that follows opens at its own start', async ({ page }) => {
  const { commands } = await open(page);
  await expect(essayTitle(page, 1)).toBeVisible();
  // From the end of Part 1, so that "its own start" is a place the reader has to be taken to.
  await reader(page).focus();
  await page.keyboard.press('End');
  await expect(page.getByTestId('end-plate')).toBeInViewport();
  await page.getByRole('button', { name: /^Part 2: / }).click();
  await expect(essayTitle(page, 2)).toBeInViewport();
  await expect.poll(() => scroller(page).evaluate((node) => node.scrollTop)).toBe(0);
  expect(navigations(commands).at(-1)).toMatchObject({ mode: 'series', direction: 'next' });

  // The key.
  await page.reload();
  await readCover(page);
  await expect(scroller(page)).toBeVisible();
  const before = navigations(commands).length;
  await reader(page).focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => navigations(commands).length).toBe(before + 1);
  expect(navigations(commands).at(-1)).toMatchObject({ mode: 'series', direction: 'next' });
});

test('a new topic is Next and the N key', async ({ page }) => {
  const { commands } = await open(page);
  await page.getByRole('button', { name: 'Next topic', exact: true }).click();
  await expect.poll(() => navigations(commands).length).toBe(1);
  expect(navigations(commands)[0]).toMatchObject({ mode: 'vertical', direction: 'next' });
  await readCover(page);
  await expect(essayTitle(page, 2)).toBeVisible();

  await reader(page).focus();
  await page.keyboard.press('n');
  await expect.poll(() => navigations(commands).length).toBe(2);
  expect(navigations(commands)[1]).toMatchObject({ mode: 'vertical', direction: 'next' });
  await readCover(page);
  await expect(essayTitle(page, 3)).toBeVisible();
});

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

/**
 * Fires the recorder's periodic report. The batch reaches the fixture a moment later (the outbox sends it
 * after the page's own async work, and a loaded runner makes that long), so a caller waits for what it
 * expects to have arrived, never for a fixed time.
 */
async function fireReport(page: Page) {
  // The recorder reports every 15 s while it has something to say.
  await page.clock.fastForward(16_000);
}

/**
 * Scrolls a stop to the top of the reading band, as a person who has read down to it, and returns once the browser has
 * measured it there. The reader counts time from that measurement, so the fake clock must not move before it: a probe
 * observer made after the scroll is told in the same turn as the reader's own observers, which were made first.
 */
async function bringToTheBand(page: Page, stopId: string) {
  await page.evaluate(async (id) => {
    const root = document.querySelector<HTMLElement>('[data-testid="folio-scroller"]');
    const beat = document.querySelector<HTMLElement>(`[data-ks-stop="${id}"]`);
    if (root === null || beat === null) throw new Error(`the scroller and the stop ${id} are on the page`);
    const bandTop = root.clientHeight * 0.42;
    root.scrollTop += beat.getBoundingClientRect().top - root.getBoundingClientRect().top - bandTop + 1;
    await new Promise<void>((measured) => {
      const probe = new IntersectionObserver(
        () => {
          probe.disconnect();
          measured();
        },
        { root },
      );
      probe.observe(beat);
    });
  }, stopId);
  // It is in the band, not above or below it.
  const place = await page.evaluate((id) => {
    const root = document.querySelector<HTMLElement>('[data-testid="folio-scroller"]')!;
    const beat = document.querySelector<HTMLElement>(`[data-ks-stop="${id}"]`)!;
    const frame = root.getBoundingClientRect();
    const box = beat.getBoundingClientRect();
    return { top: box.top - frame.top, bottom: box.bottom - frame.top, height: root.clientHeight };
  }, stopId);
  expect(place.bottom, `stop ${stopId} is below the band's top`).toBeGreaterThan(place.height * 0.42);
  expect(place.top, `stop ${stopId} is above the band's bottom`).toBeLessThan(place.height * 0.88);
}

test('reading all of Part 1 produces the facts that qualify it: every stop for its own reading time, nothing played', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  const { observed } = await open(page);

  // Read it through: each stop for the time its own words take at 230 words a minute.
  for (const stop of fixture.stops) {
    await bringToTheBand(page, stop.id);
    await page.clock.fastForward(Math.round(((stopWords(stop) * 60_000) / WORDS_PER_MINUTE_V2) * 0.5) + 300);
  }
  await fireReport(page);
  // The batches arrive in order, the last one carrying the stops read since the previous report: wait until
  // every read stop has its time (what the assertions below then state).
  const stopsReadTooShort = (): string[] => {
    const read = visibleMs(observed);
    return readStops.filter((stop) => (read.get(stop.id) ?? 0) < minVisibleMs(stopWords(stop))).map((stop) => stop.id);
  };
  await expect.poll(stopsReadTooShort, { timeout: 15_000 }).toEqual([]);
  // A call is text with nothing to answer, so reading is all that is reported.
  expect(observed.filter((event) => event.kind === 'scroll.block_interaction')).toEqual([]);
  // Every event is one the server's intake schema accepts, so the facts above are what it would store.
  for (const event of observed)
    InteractionEventSchema.parse({ ...envelope(), kind: event.kind, payload: event.payload });
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
    test(`no serious violations at ${String(viewport.width)} × ${String(viewport.height)}, with asides open, the end plate and its small print, the text version and the ••• sheet`, async ({
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
      // The document's own asides are collapsed until the reader opens them.
      for (const name of [/^Tangent: /, /^Small print: Where this stops/]) {
        const aside = page.getByRole('button', { name });
        await aside.scrollIntoViewIfNeeded();
        await aside.click();
        await expect(aside).toHaveAttribute('aria-expanded', 'true');
      }
      await expect(page.getByText(/Light sets the season/)).toBeVisible();
      expect(await audit()).toEqual([]);
      await reader(page).focus();
      await page.keyboard.press('End');
      const plate = page.getByTestId('end-plate');
      await expect(plate.getByText('To sum up')).toBeInViewport();
      await plate.getByRole('button', { name: 'Small print', exact: true }).click();
      await expect(page.getByTestId('end-small-print')).toBeVisible();
      expect(await audit()).toEqual([]);
      await reader(page).focus();
      await page.keyboard.press('t');
      await expect(page.locator('[data-ks-figure] [role="img"]')).toHaveCount(0);
      expect(await audit()).toEqual([]);
      await page.getByRole('button', { name: 'More', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'More', exact: true })).toBeVisible();
      await page.waitForTimeout(400);
      expect(await audit()).toEqual([]);
    });
  }
});

/** A finger on the page, moved by the browser's own touch events (the path a phone takes). */
async function fingerDown(page: Page, at: { x: number; y: number }) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
  let from = at;
  return {
    async to(next: { x: number; y: number }) {
      for (let step = 1; step <= 6; step += 1) {
        const along = step / 6;
        const point = { x: from.x + (next.x - from.x) * along, y: from.y + (next.y - from.y) * along };
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point] });
      }
      from = next;
    },
    async up() {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    },
  };
}

/** The middle of the essay's visible column, and its height. */
async function middle(page: Page) {
  const box = await scroller(page).boundingBox();
  if (box === null) throw new Error('the essay is on the page');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, height: box.height };
}

async function toTheVeryEnd(page: Page) {
  await reader(page).focus();
  await page.keyboard.press('End');
  await expect
    .poll(() => scroller(page).evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop))
    .toBeLessThan(2);
}

test.describe('a pull up past the end, by finger', () => {
  test.use({ hasTouch: true });

  test('is the next topic; the same pull in the middle of the essay is reading', async ({ page }) => {
    const { commands } = await open(page);
    const { x, y, height } = await middle(page);
    const before = await scroller(page).evaluate((node) => node.scrollTop);
    const mid = await fingerDown(page, { x, y: y + height * 0.3 });
    await mid.to({ x, y: y - height * 0.3 });
    await mid.up();
    await expect.poll(() => scroller(page).evaluate((node) => node.scrollTop)).toBeGreaterThan(before);
    // A pull is decided as the finger lifts; there is nothing more to wait for if none was made.
    await page.waitForTimeout(300);
    expect(navigations(commands)).toEqual([]);

    await toTheVeryEnd(page);
    const pull = await fingerDown(page, { x, y: y + height * 0.3 });
    await pull.to({ x, y: y - height * 0.3 });
    await pull.up();
    await expect.poll(() => navigations(commands).length).toBe(1);
    expect(navigations(commands)[0]).toMatchObject({ mode: 'vertical', direction: 'next' });
    await readCover(page);
    await expect(essayTitle(page, 2)).toBeVisible();
  });

  test('fills the meter on the end plate as it goes, and a short pull moves nothing', async ({ page }) => {
    const { commands } = await open(page);
    await toTheVeryEnd(page);
    await expect(page.getByTestId('pull-handle')).toBeVisible();
    const fill = page.getByTestId('pull-meter-fill');
    const width = () => fill.evaluate((node) => node.getBoundingClientRect().width);
    expect(await width()).toBe(0);
    const { x, y } = await middle(page);
    const finger = await fingerDown(page, { x, y });
    await finger.to({ x, y: y - 48 });
    await expect.poll(width).toBeGreaterThan(5);
    const half = await width();
    await finger.to({ x, y: y - 80 });
    await expect.poll(width).toBeGreaterThan(half);
    await finger.to({ x, y: y - 20 });
    await finger.up();
    await expect.poll(width).toBe(0);
    expect(navigations(commands)).toEqual([]);
    await expect(essayTitle(page, 1)).toBeVisible();
  });
});

test.describe('a pull that starts at the end, by finger, when the reader has not yet heard of the scroll', () => {
  test.use({ hasTouch: true });

  test('is still the next topic: whether the page is at its end is read from the page as the finger goes down', async ({
    page,
  }) => {
    const { commands } = await open(page);
    // Holds back the first scroll report for 2 s: the page is at the end, the reader has not been told.
    await scroller(page).evaluate((node) => {
      let held = true;
      node.addEventListener(
        'scroll',
        (event) => {
          if (!held) return;
          held = false;
          event.stopImmediatePropagation();
          window.setTimeout(() => node.dispatchEvent(new Event('scroll')), 2000);
        },
        true,
      );
    });
    await toTheVeryEnd(page);
    const { x, y, height } = await middle(page);
    const pull = await fingerDown(page, { x, y: y + height * 0.3 });
    await pull.to({ x, y: y - height * 0.3 });
    await pull.up();
    await expect.poll(() => navigations(commands).length).toBe(1);
    expect(navigations(commands)[0]).toMatchObject({ mode: 'vertical', direction: 'next' });
  });
});

test('a mouse drag up the text at the end selects words and moves on nowhere', async ({ page }) => {
  const { commands } = await open(page, phone);
  await toTheVeryEnd(page);
  // The summary is the end plate's text: from its last line, up to its first (or the top of the essay).
  const words = page.getByTestId('end-plate').getByTestId('end-summary');
  const box = await words.boundingBox();
  if (box === null) throw new Error('the end plate is on the page');
  const { y: middleY, height } = await middle(page);
  const top = middleY - height / 2;
  await page.mouse.move(box.x + box.width - 2, box.y + box.height - 6);
  await page.mouse.down();
  await page.mouse.move(box.x + 2, Math.max(box.y + 4, top + 8), { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString().length ?? 0)).toBeGreaterThan(0);
  // A pull is decided as the press lifts; there is nothing more to wait for if none was made.
  await page.waitForTimeout(300);
  expect(navigations(commands)).toEqual([]);
  await expect(essayTitle(page, 1)).toBeAttached();
});

test('a screen without touch shows no pull meter: Next idea and N are the ways on there', async ({ page }) => {
  await open(page, desktop);
  await toTheVeryEnd(page);
  await expect(page.getByTestId('end-plate').getByRole('button', { name: /Next idea/ })).toBeVisible();
  await expect(page.getByTestId('pull-handle')).toHaveCount(0);
});

test('a mouse wheel right after Home takes over from the jump instead of being undone by it', async ({ page }) => {
  await open(page, desktop);
  await toTheVeryEnd(page);
  await page.keyboard.press('Home');
  // While the smooth scroll to the start is still under way, as a person does who overshoots.
  await page.waitForTimeout(150);
  const { x, y } = await middle(page);
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, 300);
  const top = () => scroller(page).evaluate((node) => node.scrollTop);
  // Settled: the same position twice in a row, half a second apart.
  let settled = -1;
  await expect
    .poll(
      async () => {
        const now = await top();
        const still = now === settled;
        settled = now;
        return still;
      },
      { intervals: [500] },
    )
    .toBe(true);
  expect(settled).toBeGreaterThan(0);
  // And not left back near the end: the wheel stopped the jump on its way up.
  const most = await scroller(page).evaluate((node) => node.scrollHeight - node.clientHeight);
  expect(settled).toBeLessThan(most);
});
