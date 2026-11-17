import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { exportCarries } from './export-files';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import circulation from '@knowscroll/scroll-model/fixtures/circulation-stage-ci.json';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import type { ScrollDocumentV2 } from '@knowscroll/scroll-model';

/**
 * The Folio reader in a real browser (the gallery export, `/gallery-folio`, labelled CI fixture documents): every stop as
 * a beat in order, a call drawn as text, a held figure that pins and changes state while its beats pass (phone, and beside
 * them on a wide screen), what the reader reports as read, the keys, reduced motion, small screens and 200 % text, axe,
 * Earth's tilt control, and opening at a stop. Screenshots are written only when `KS_FOLIO_SHOTS` names a folder
 * (outside the repository).
 */

const documents = {
  seasons: seasons as unknown as ScrollDocumentV2,
  circulation: circulation as unknown as ScrollDocumentV2,
};
type Name = keyof typeof documents;

const phone = { width: 390, height: 844 };
const desktop = { width: 1440, height: 900 };
const sizes = [
  { label: 'phone', viewport: phone },
  { label: 'desktop', viewport: desktop },
] as const;

async function shot(page: Page, name: string) {
  const folder = process.env['KS_FOLIO_SHOTS'];
  if (folder === undefined) return;
  mkdirSync(folder, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(folder, `${name}.png`) });
}

const scroller = (page: Page) => page.getByTestId('folio-scroller');
const reader = (page: Page) => page.getByRole('group', { name: 'Scroll reader' });

/** Opens the gallery page on a document at a size, and waits until the essay has laid out. */
async function open(
  page: Page,
  name: Name,
  viewport: { width: number; height: number },
  query: Record<string, string> = {},
) {
  await page.setViewportSize(viewport);
  const params = new URLSearchParams({ doc: name, ...query });
  await page.goto(`/gallery-folio?${params.toString()}`);
  await expect(page.getByTestId('ks-folio-gallery')).toBeVisible();
  await expect(scroller(page).getByRole('heading', { level: 1, name: documents[name].title })).toBeVisible();
  // The essay is laid out when its height stops changing.
  let last = -1;
  await expect
    .poll(async () => {
      const now = await scroller(page).evaluate((node) => node.scrollHeight);
      const settled = now === last;
      last = now;
      return settled;
    })
    .toBe(true);
}

const scrollTo = (page: Page, top: number) =>
  scroller(page).evaluate((node, value) => {
    node.scrollTop = value;
  }, top);

/** Positions relative to the top of the scroller, in px. */
async function boxIn(page: Page, selector: string) {
  return page.evaluate((query) => {
    const root = document.querySelector('[data-testid="folio-scroller"]');
    const node = document.querySelector(query);
    if (root === null || node === null) return undefined;
    const frame = root.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    return {
      top: box.top - frame.top,
      bottom: box.bottom - frame.top,
      left: box.left,
      right: box.right,
      frameHeight: frame.height,
    };
  }, selector);
}

const stopIdsOnPage = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-ks-stop]')]
      .map((node) => node.getAttribute('data-ks-stop') ?? '')
      .filter((id) => id !== 'end'),
  );

interface GalleryEvents {
  visibility: { blockId: string; visibleFraction: number; at: number }[];
  activity: { active: boolean; at: number }[];
  stops: (string | null | undefined)[];
}
const galleryEvents = (page: Page) =>
  page.evaluate(() => (window as unknown as { __ksFolioGallery: GalleryEvents }).__ksFolioGallery);

for (const { label, viewport } of sizes) {
  for (const name of ['seasons', 'circulation'] as const) {
    test(`every stop of ${name} is a beat, once, in order; a call is text, at ${label}`, async ({ page }) => {
      await open(page, name, viewport);
      const document = documents[name];
      expect(await stopIdsOnPage(page)).toEqual(document.stops.map((stop) => stop.id));
      // Each wrapper says whether it is read or a call, from the document's own kinds.
      for (const stop of document.stops) {
        await expect(page.locator(`[data-ks-stop="${stop.id}"]`)).toHaveAttribute(
          'data-ks-kind',
          stop.kind === 'read' ? 'read' : 'call',
        );
      }
      const calls = document.stops.filter((stop) => stop.kind !== 'read');
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        const beat = page.getByTestId(`beat-${call.id}`);
        await beat.scrollIntoViewIfNeeded();
        await expect(beat.getByText(call.prompt, { exact: true })).toBeVisible();
        await expect(beat.getByText(call.explain, { exact: true })).toBeVisible();
        // Drawn as text: no options to pick and nothing to lock in.
        await expect(beat.getByRole('radio')).toHaveCount(0);
        await expect(beat.getByRole('button', { name: 'Lock it in' })).toHaveCount(0);
      }
      await expect(page.getByRole('radio')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Lock it in' })).toHaveCount(0);
      await scrollTo(page, 0);
      await shot(page, `${name}-${label}-top`);
    });
  }
}

/** Where the first hold's figure and beats are at one step of the scroll. */
interface HoldRow {
  scrollTop: number;
  figureTop: number;
  figureBottom: number;
  figureLeft: number;
  key: string;
  firstBeatTop: number;
  beatsRight: number;
}

async function holdRow(page: Page): Promise<HoldRow> {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="folio-scroller"]') as HTMLElement;
    const hold = document.querySelector('[data-testid^="hold-"]');
    if (hold === null) throw new Error('the page has a hold');
    const frame = root.getBoundingClientRect();
    const plate = hold.querySelector('[data-testid="held-figure"] [data-ks-figure]') as HTMLElement;
    const figure = plate.getBoundingClientRect();
    const beats = [...hold.querySelectorAll('[data-ks-stop]')].map((node) => node.getBoundingClientRect());
    const first = beats[0];
    if (first === undefined) throw new Error('the hold has beats');
    return {
      scrollTop: root.scrollTop,
      figureTop: figure.top - frame.top,
      figureBottom: figure.bottom - frame.top,
      figureLeft: figure.left,
      key: plate.getAttribute('data-ks-figure') ?? '',
      firstBeatTop: first.top - frame.top,
      beatsRight: Math.max(...beats.map((box) => box.right)),
    };
  });
}

/** Steps the scroller down in 120 px steps from the top until the first hold's figure has left, and records each step. */
async function throughTheFirstHold(page: Page, label: string): Promise<HoldRow[]> {
  const rows: HoldRow[] = [];
  const most = await scroller(page).evaluate((node) => node.scrollHeight - node.clientHeight);
  for (let top = 0; top <= most; top += 120) {
    await scrollTo(page, top);
    // The held figure follows the scroll through React state: give it a frame or two.
    await page.waitForTimeout(200);
    const row = await holdRow(page);
    rows.push(row);
    await shot(page, `hold-${label}-${String(top).padStart(4, '0')}`);
    if (row.figureBottom < -40) break;
  }
  return rows;
}

for (const { label, viewport } of sizes) {
  test(`the first hold of circulation pins its figure, changes its state and releases it, at ${label}`, async ({
    page,
  }) => {
    await open(page, 'circulation', viewport);
    await expect(page.locator('[data-testid^="hold-"]').first()).toBeVisible();
    const rows = await throughTheFirstHold(page, label);
    const first = rows[0];
    const last = rows.at(-1);
    if (first === undefined || last === undefined) throw new Error('the hold was stepped through');

    // The figure is the pinned figure when it sits at the top of the scroller (its panel's padding is under 24 px).
    const pinnedTop = Math.min(...rows.map((row) => row.figureTop).filter((top) => top >= -2));
    const pinned = rows.filter((row) => Math.abs(row.figureTop - pinnedTop) <= 3);
    // It arrived from below, so it was pinned by the scroll and not drawn there.
    expect(first.figureTop).toBeGreaterThan(pinnedTop + 40);
    expect(pinnedTop).toBeLessThan(24);
    expect(pinned.length).toBeGreaterThanOrEqual(3);
    // Across the pinned steps the beat moves up and the figure does not.
    const beatTravel = pinned[0] === undefined ? 0 : pinned[0].firstBeatTop - (pinned.at(-1)?.firstBeatTop ?? 0);
    expect(beatTravel).toBeGreaterThanOrEqual(240);
    for (const row of pinned) expect(Math.abs(row.figureTop - pinnedTop)).toBeLessThanOrEqual(3);
    // And when the hold is over it scrolls away: its bottom is above the top of the scroller.
    expect(last.figureBottom).toBeLessThan(0);

    if (label === 'desktop') {
      // Beside its beats: the figure's left edge is to the right of every beat's right edge.
      for (const row of rows) expect(row.figureLeft).toBeGreaterThan(row.beatsRight);
    } else {
      // Above its beats on a phone: the figure is as wide as the column, not beside it.
      for (const row of rows) expect(row.figureLeft).toBeLessThan(row.beatsRight);
    }
  });
}

for (const { label, viewport } of sizes) {
  test(`the held figure of circulation takes at least two states while it is pinned, at ${label}`, async ({ page }) => {
    await open(page, 'circulation', viewport);
    const rows = await throughTheFirstHold(page, `states-${label}`);
    const pinnedTop = Math.min(...rows.map((row) => row.figureTop).filter((top) => top >= -2));
    const pinned = rows.filter((row) => Math.abs(row.figureTop - pinnedTop) <= 3);
    expect(pinned.length).toBeGreaterThanOrEqual(3);
    expect(new Set(pinned.map((row) => row.key)).size).toBeGreaterThanOrEqual(2);
  });
}

for (const { label, viewport } of sizes) {
  for (const name of ['circulation', 'seasons'] as const) {
    test(`reading ${name} from top to end reports a few stops at a time, each stop once read, in order, at ${label}`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await open(page, name, viewport);
      const document = documents[name];
      const most = await scroller(page).evaluate((node) => node.scrollHeight - node.clientHeight);
      for (let top = 0; top < most; top += 60) {
        await scrollTo(page, top);
        await page.waitForTimeout(35);
      }
      await scrollTo(page, most);
      await expect.poll(async () => (await galleryEvents(page)).stops.at(-1) ?? null).toBeNull();
      await shot(page, `reading-end-${label}`);

      const { visibility, stops } = await galleryEvents(page);
      // Replay the reports in order, keeping each block's latest fraction.
      const latest = new Map<string, number>();
      const reached = new Set<string>();
      let most_at_once = 0;
      for (const entry of visibility) {
        latest.set(entry.blockId, entry.visibleFraction);
        if (entry.visibleFraction >= 0.5) reached.add(entry.blockId);
        most_at_once = Math.max(most_at_once, [...latest.values()].filter((fraction) => fraction >= 0.5).length);
      }
      expect(most_at_once).toBeLessThanOrEqual(3);
      for (const stop of document.stops.filter((entry) => entry.kind === 'read'))
        expect(reached.has(stop.id), `read stop ${stop.id} reached half visibility`).toBe(true);
      // Every id reported is a stop of the document.
      for (const id of latest.keys()) expect(document.stops.map((stop) => stop.id)).toContain(id);

      // The stop being read follows the document's order, repeating only the same id in a row, and ends at the end plate.
      const order = document.stops.map((stop) => stop.id);
      const deduped = stops.filter((id, index) => index === 0 || id !== stops[index - 1]);
      const ids = deduped.filter((id): id is string => typeof id === 'string');
      const indexes = ids.map((id) => order.indexOf(id));
      expect(indexes.every((index) => index >= 0)).toBe(true);
      expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids[0]).toBe(order[0]);
      expect(deduped.at(-1) ?? null).toBeNull();
      // The end plate is only entered once: the null is not in the middle.
      expect(deduped.filter((id) => id === null || id === undefined)).toHaveLength(1);
    });
  }
}

/** Whether a box is inside the scroller's own frame, at least in part. */
async function inView(page: Page, selector: string): Promise<boolean> {
  const box = await boxIn(page, selector);
  return box !== undefined && box.bottom > 0 && box.top < box.frameHeight;
}

test.describe('keys', () => {
  test('End goes to the end plate, Home to the title, T turns every picture into its words', async ({ page }) => {
    await open(page, 'circulation', phone);
    await reader(page).focus();
    await page.keyboard.press('End');
    await expect.poll(() => inView(page, '[data-testid="end-plate"]')).toBe(true);
    await expect(page.getByTestId('end-plate').getByText('The short version')).toBeVisible();
    await page.keyboard.press('Home');
    await expect.poll(() => inView(page, '[data-testid="folio-scroller"] h1')).toBe(true);
    await expect.poll(() => scroller(page).evaluate((node) => node.scrollTop)).toBe(0);

    // Every plate is a picture named by its words until T.
    const plates = page.locator('[data-ks-figure]');
    const count = await plates.count();
    expect(count).toBeGreaterThan(2);
    const words = await plates.evaluateAll((nodes) =>
      nodes.map((node) => node.querySelector('[role="img"]')?.getAttribute('aria-label') ?? ''),
    );
    expect(words.every((alt) => alt !== '')).toBe(true);
    await expect(page.locator('[data-ks-figure] [role="img"]')).toHaveCount(count);
    await page.keyboard.press('t');
    await expect(page.locator('[data-ks-figure] [role="img"]')).toHaveCount(0);
    for (const [index, alt] of words.entries()) await expect(plates.nth(index)).toContainText(alt);
    // T again brings the pictures back.
    await page.keyboard.press('t');
    await expect(page.locator('[data-ks-figure] [role="img"]')).toHaveCount(count);
  });

  test('a figure’s own Text chip turns that one picture into its words', async ({ page }) => {
    await open(page, 'circulation', phone);
    const hold = page.locator('[data-testid^="hold-"]').first();
    const plate = hold.locator('[data-ks-figure]');
    const chip = plate.getByRole('button', { name: 'Text version of this picture' });
    await expect(plate.getByRole('img')).toBeVisible();
    await chip.click();
    await expect(plate.getByRole('img')).toHaveCount(0);
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await chip.click();
    await expect(plate.getByRole('img')).toBeVisible();
  });

  test('Space and Page Down move a screen, Shift+Space back, and the arrow keys a step', async ({ page }) => {
    await open(page, 'seasons', phone);
    await reader(page).focus();
    const top = () => scroller(page).evaluate((node) => node.scrollTop);
    await page.keyboard.press('ArrowDown');
    await expect.poll(top).toBeGreaterThan(50);
    const step = await top();
    await page.keyboard.press('Space');
    await expect.poll(top).toBeGreaterThan(step + 200);
    const screen = await top();
    await page.keyboard.press('Shift+Space');
    await expect.poll(top).toBeLessThan(screen - 200);
  });
});

for (const { label, viewport } of sizes) {
  test(`under reduced motion a held figure cross-fades and never tweens, at ${label}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, 'circulation', viewport, { motion: 'reduce' });
    await page.evaluate(() => {
      const seen: { key: string; transition: string }[] = [];
      (window as unknown as { __figures: typeof seen }).__figures = seen;
      new MutationObserver((records) => {
        for (const record of records) {
          const node = record.target as HTMLElement;
          if (node.closest('[data-testid="held-figure"]') === null) continue;
          seen.push({
            key: node.getAttribute('data-ks-figure') ?? '',
            transition: node.getAttribute('data-ks-figure-transition') ?? '',
          });
        }
      }).observe(document.body, {
        subtree: true,
        attributes: true,
        attributeFilter: ['data-ks-figure', 'data-ks-figure-transition'],
      });
    });
    const rows = await throughTheFirstHold(page, `reduced-${label}`);
    expect(new Set(rows.map((row) => row.key)).size, 'the held figure changed state').toBeGreaterThanOrEqual(2);
    const seen = await page.evaluate(() => (window as unknown as { __figures: { transition: string }[] }).__figures);
    const transitions = seen.map((entry) => entry.transition);
    expect(transitions).toContain('crossfade');
    expect(transitions).not.toContain('tween');
  });
}

test('without reduced motion the same hold glides (the control for the reduced-motion test)', async ({ page }) => {
  await open(page, 'circulation', phone);
  const rows = await throughTheFirstHold(page, 'full-motion');
  expect(new Set(rows.map((row) => row.key)).size).toBeGreaterThanOrEqual(2);
  const transition = await page
    .locator('[data-testid="held-figure"] [data-ks-figure]')
    .first()
    .getAttribute('data-ks-figure-transition');
  expect(transition).toBe('tween');
});

for (const name of ['seasons', 'circulation'] as const) {
  const cases: { label: string; viewport: { width: number; height: number }; query: Record<string, string> }[] = [
    { label: '320 x 640', viewport: { width: 320, height: 640 }, query: {} },
    { label: '200 % text at 390 x 844', viewport: phone, query: { scale: '2' } },
  ];
  for (const { label, viewport, query } of cases) {
    test(`${name} at ${label} does not scroll sideways and shows its title`, async ({ page }) => {
      await open(page, name, viewport, query);
      const sizesOf = () =>
        page.evaluate(() => ({
          page: document.documentElement.scrollWidth,
          inner: window.innerWidth,
          essay:
            (document.querySelector('[data-testid="folio-scroller"]') as HTMLElement).scrollWidth -
            (document.querySelector('[data-testid="folio-scroller"]') as HTMLElement).clientWidth,
        }));
      await expect(scroller(page).getByRole('heading', { level: 1 })).toBeInViewport();
      let measured = await sizesOf();
      expect(measured.page).toBeLessThanOrEqual(measured.inner);
      expect(measured.essay).toBeLessThanOrEqual(1);
      await shot(page, `${name}-${label.replace(/[^a-z0-9]+/gi, '-')}`);
      // Down through the essay and the end plate: still nothing sideways.
      await reader(page).focus();
      await page.keyboard.press('End');
      await expect.poll(() => inView(page, '[data-testid="end-plate"]')).toBe(true);
      measured = await sizesOf();
      expect(measured.page).toBeLessThanOrEqual(measured.inner);
      expect(measured.essay).toBeLessThanOrEqual(1);
    });
  }
}

for (const { label, viewport } of sizes) {
  test(`axe finds nothing serious or critical on seasons at ${label}`, async ({ page }) => {
    await open(page, 'seasons', viewport);
    const audit = async () => {
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
        .analyze();
      return results.violations
        .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
        .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(' | ')}`);
    };
    expect(await audit()).toEqual([]);
    // And with the pictures as words, and at the end plate.
    await reader(page).focus();
    await page.keyboard.press('t');
    await expect(page.locator('[data-ks-figure] [role="img"]')).toHaveCount(0);
    await page.keyboard.press('End');
    await expect.poll(() => inView(page, '[data-testid="end-plate"]')).toBe(true);
    expect(await audit()).toEqual([]);
  });
}

test('the Earth tilt slider sits under the figure after the Final call, and its keys change the figure’s words', async ({
  page,
}) => {
  await open(page, 'seasons', phone);
  const final = seasons.stops.at(-1);
  if (final === undefined) throw new Error('seasons has a Final call');
  expect(final.kind).toBe('final_call');
  const figure = page.getByTestId(`figure-figure-${final.id}`);
  await figure.scrollIntoViewIfNeeded();
  const slider = page.getByRole('slider', { name: 'Earth’s tilt' });
  await expect(slider).toHaveCount(1);
  await expect(slider).toBeVisible();

  const beat = await page.getByTestId(`beat-${final.id}`).boundingBox();
  const plate = await figure.locator('[data-ks-figure]').boundingBox();
  const control = await slider.boundingBox();
  if (beat === null || plate === null || control === null) throw new Error('the call, figure and slider are laid out');
  expect(plate.y).toBeGreaterThanOrEqual(beat.y + beat.height - 1);
  expect(control.y).toBeGreaterThanOrEqual(plate.y + plate.height - 1);

  const picture = figure.getByRole('img');
  const before = await picture.getAttribute('aria-label');
  expect(before ?? '').not.toBe('');
  await slider.focus();
  await page.keyboard.press('Home');
  await expect(page.getByTestId('tilt-value')).toHaveText('0°');
  await expect.poll(() => picture.getAttribute('aria-label')).not.toBe(before);
  const flat = await picture.getAttribute('aria-label');
  await page.keyboard.press('End');
  await expect.poll(() => picture.getAttribute('aria-label')).not.toBe(flat);
  await shot(page, 'seasons-tilt');
});

/** The beat's top, in px under the top of the scroller, once the place has settled. */
const settledTop = async (page: Page, selector: string) => {
  await page.waitForTimeout(800);
  return (await boxIn(page, selector))?.top ?? Number.NaN;
};

for (const { label, viewport } of sizes) {
  const cases: { name: Name; stop: string | undefined }[] = [
    { name: 'seasons', stop: seasons.stops[Math.floor(seasons.stops.length / 2)]?.id },
    { name: 'circulation', stop: 'circuits' },
    { name: 'seasons', stop: 'equinox' },
    { name: 'circulation', stop: 'oxygen-lungs' },
    { name: 'circulation', stop: 'tense' },
  ];
  for (const { name, stop } of cases) {
    test(`?stop=${String(stop)} opens ${name} with that beat in view and read, at ${label}`, async ({ page }) => {
      if (stop === undefined) throw new Error('the document has a middle stop');
      expect(documents[name].stops.map((entry) => entry.id)).toContain(stop);
      await open(page, name, viewport, { stop });
      const selector = `[data-testid="beat-${stop}"]`;
      const top = await settledTop(page, selector);
      // A beat lands at the top of the reading band (42 % down), so it is the stop being read, and a held figure, pinned
      // above the band, shows its state: in view, in the upper part of the screen.
      const held = page.locator(`[data-testid^="hold-"] ${selector}`);
      const frameHeight = await scroller(page).evaluate((element) => element.clientHeight);
      expect(top, 'the beat is in view').toBeGreaterThanOrEqual(0);
      expect(top, 'the beat is in the upper part of the scroller').toBeLessThanOrEqual(frameHeight * 0.6);
      const pinned = await boxIn(page, '[data-testid="held-figure"]');
      if ((await held.count()) > 0 && label === 'phone' && pinned !== undefined && pinned.top >= -2 && pinned.top < 24)
        expect(top, 'the beat opens below the pinned figure').toBeGreaterThanOrEqual(pinned.bottom - 2);
      // What the reader said it was reading while opening is only what is on screen: never a stop far down the essay.
      const { stops } = await galleryEvents(page);
      const onScreen = await page.evaluate(() => {
        const frame = document.querySelector('[data-testid="folio-scroller"]')?.getBoundingClientRect();
        if (frame === undefined) return [];
        return [...document.querySelectorAll('[data-ks-stop]')]
          .filter((node) => {
            const box = node.getBoundingClientRect();
            return box.bottom > frame.top && box.top < frame.bottom;
          })
          .map((node) => node.getAttribute('data-ks-stop'));
      });
      expect(stops[0]).toBe(stop);
      for (const reported of stops) expect(onScreen, `reported ${String(reported)}`).toContain(reported);
      await shot(page, `stop-${stop}-${name}-${label}`);
    });
  }
}

test('a stop the document does not have opens the essay at its start and is never reported', async ({ page }) => {
  await open(page, 'seasons', { width: 390, height: 844 }, { stop: 'no-such-stop' });
  const top = await scroller(page).evaluate((node) => node.scrollTop);
  expect(top).toBe(0);
  const { stops } = await galleryEvents(page);
  expect(stops).not.toContain('no-such-stop');
  expect(stops[0]).toBe(seasons.stops[0]?.id);
});

test('the gallery build carries the Folio gallery marker (the control for the production export check)', () => {
  expect(exportCarries(join(__dirname, '..', 'dist-gallery'), 'ks-folio-gallery')).toBe(true);
});
