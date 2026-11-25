import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { exportCarries } from './export-files';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import fenceV3 from '@knowscroll/scroll-model/fixtures/fence-v3-ci.json';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import seasonsV3 from '@knowscroll/scroll-model/fixtures/seasons-v3-ci.json';
import { beatsOfV3, type ScrollDocumentV2, type ScrollDocumentV3 } from '@knowscroll/scroll-model';

/**
 * The Folio reader in a real browser (the gallery export, `/gallery-folio`, labelled CI fixture documents): every stop as
 * a beat in order, a call drawn as text, a held figure that changes state while its beats pass (pinned above them on a
 * phone, beside them on a wide screen), what the reader reports as read, the keys, small screens and 200 % text, axe, and
 * opening at a stop. The stored v2 fixture `seasons` (Earth & sky's stage) draws no figure any more, no drawing kit being left
 * (#835), so it is read here as text; every test of a figure, a hold, the Text chip or reduced motion on one is on a
 * document v3 (`seasonsV3`, and the held-figure tests of `folio-v3-smoke.spec.ts`). Screenshots are written only when
 * `KS_FOLIO_SHOTS` names a folder (outside the repository).
 */

/** The `scroll-document.v2` fixtures: the tests that read a stop's kind, its prompt and its words need these. */
const v2Documents = {
  seasons: seasons as unknown as ScrollDocumentV2,
};
type V2Name = keyof typeof v2Documents;
/** Every fixture the page opens by name (`?doc=`); a document v3 has beats in sections, not stops. */
const documents = {
  ...v2Documents,
  fenceV3: fenceV3 as unknown as ScrollDocumentV3,
  seasonsV3: seasonsV3 as unknown as ScrollDocumentV3,
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
  covers: string[];
}
const galleryEvents = (page: Page) =>
  page.evaluate(() => (window as unknown as { __ksFolioGallery: GalleryEvents }).__ksFolioGallery);

for (const { label, viewport } of sizes) {
  for (const name of ['seasons'] as const satisfies readonly V2Name[]) {
    test(`every stop of ${name} is a beat, once, in order; a call is text, at ${label}`, async ({ page }) => {
      await open(page, name, viewport);
      const document = v2Documents[name];
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
      // The stored stage (Earth & sky's) is parsed and served but not drawn: no plate, no hold, no tilt slider (#835).
      await expect(page.locator('[data-ks-figure]')).toHaveCount(0);
      await expect(page.locator('[data-testid^="hold-"]')).toHaveCount(0);
      await expect(page.getByRole('slider')).toHaveCount(0);
      await scrollTo(page, 0);
      await shot(page, `${name}-${label}-top`);
    });
  }
}

/** Where the first hold's figure and beats are at one step of the scroll. */
interface HoldRow {
  scrollTop: number;
  viewport: number;
  figureTop: number;
  figureBottom: number;
  figureLeft: number;
  key: string;
  firstBeatTop: number;
  lastBeatTop: number;
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
      viewport: root.clientHeight,
      figureTop: figure.top - frame.top,
      figureBottom: figure.bottom - frame.top,
      figureLeft: figure.left,
      key: plate.getAttribute('data-ks-figure') ?? '',
      firstBeatTop: first.top - frame.top,
      lastBeatTop: (beats.at(-1) ?? first).top - frame.top,
      beatsRight: Math.max(...beats.map((box) => box.right)),
    };
  });
}

/** How far each step of `throughTheFirstHold` scrolls. */
const HOLD_STEP = 60;

/** Steps the scroller down from the top until the first hold's figure has left, and records each step. */
async function throughTheFirstHold(page: Page, label: string): Promise<HoldRow[]> {
  const rows: HoldRow[] = [];
  const most = await scroller(page).evaluate((node) => node.scrollHeight - node.clientHeight);
  for (let top = 0; top <= most; top += HOLD_STEP) {
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

test('the first hold of seasonsV3 keeps its figure beside its beats, in full view while it changes state, at desktop', async ({
  page,
}) => {
  // The document v3 seasons essay: this test is about a hold whose beats are shorter than the figure (the comment below). The
  // first hold of seasonsV3 is two beats of about 125 and 210 characters, each changing the picture. The v2 `seasons` hold
  // tests this file had (pinned above its beats at a phone, reduced motion, the glide) are the v3 ones of `folio-v3-smoke.spec.ts`
  // on the Broad Street essay, whose first hold is three beats.
  await open(page, 'seasonsV3', sizes[1].viewport);
  await expect(page.locator('[data-testid^="hold-"]').first()).toBeVisible();
  const rows = await throughTheFirstHold(page, 'desktop');
  const first = rows[0];
  const last = rows.at(-1);
  if (first === undefined || last === undefined) throw new Error('the hold was stepped through');

  // Beside its beats: the figure's left edge is to the right of every beat's right edge, and the beats start level
  // with it, with no blank above them (#769, D-434).
  for (const row of rows) expect(row.figureLeft).toBeGreaterThan(row.beatsRight);
  for (const row of rows) expect(Math.abs(row.firstBeatTop - row.figureTop)).toBeLessThanOrEqual(24);
  // It arrives from below and takes two or more states while the whole figure is in view. These beats are shorter than
  // the figure, so it need not pin: it goes up with them.
  expect(first.figureTop).toBeGreaterThan(40);
  const inView = rows.filter((row) => row.figureTop >= -3 && row.figureBottom <= row.viewport + 3);
  expect(new Set(inView.map((row) => row.key)).size).toBeGreaterThanOrEqual(2);
  // And when the hold is over it scrolls away: its bottom is above the top of the scroller.
  expect(last.figureBottom).toBeLessThan(0);
});

for (const { label, viewport } of sizes) {
  for (const name of ['seasons'] as const satisfies readonly V2Name[]) {
    test(`reading ${name} from top to end reports a few stops at a time, each stop once read, in order, at ${label}`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await open(page, name, viewport);
      const document = v2Documents[name];
      const most = await scroller(page).evaluate((node) => node.scrollHeight - node.clientHeight);
      for (let top = 0; top < most; top += 60) {
        await scrollTo(page, top);
        await page.waitForTimeout(35);
      }
      await scrollTo(page, most);
      await expect.poll(async () => (await galleryEvents(page)).stops.at(-1) ?? null).toBeNull();
      await shot(page, `reading-end-${label}`);

      const { visibility, stops } = await galleryEvents(page);
      // Replay the reports in order, keeping each block's latest fraction. Reports less than a millisecond apart on the
      // reader's clock (`at`) are one observation: each beat's observer reports on its own, so within one frame a beat
      // coming in can be reported before the one going out, and the recorder, which times what is visible by `at`,
      // credits that order no time to speak of. The count is taken after every report of one observation.
      const latest = new Map<string, number>();
      const reached = new Set<string>();
      let most_at_once = 0;
      visibility.forEach((entry, index) => {
        latest.set(entry.blockId, entry.visibleFraction);
        if (entry.visibleFraction >= 0.5) reached.add(entry.blockId);
        const next = visibility[index + 1];
        if (next !== undefined && next.at - entry.at < 1) return;
        most_at_once = Math.max(most_at_once, [...latest.values()].filter((fraction) => fraction >= 0.5).length);
      });
      // A stored v2 draws no figure since #835, so its short stops sit closer: a 1440 x 900 screen holds four at half
      // visibility, a phone three. Still a few at a time, never the whole essay (seasons has thirteen stops).
      expect(most_at_once).toBeLessThanOrEqual(label === 'desktop' ? 4 : 3);
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
  test('End goes to the end plate and Home to the title', async ({ page }) => {
    await open(page, 'seasons', phone);
    await reader(page).focus();
    await page.keyboard.press('End');
    await expect.poll(() => inView(page, '[data-testid="end-plate"]')).toBe(true);
    await expect(page.getByTestId('end-plate').getByText('To sum up')).toBeVisible();
    await page.keyboard.press('Home');
    await expect.poll(() => inView(page, '[data-testid="folio-scroller"] h1')).toBe(true);
    await expect.poll(() => scroller(page).evaluate((node) => node.scrollTop)).toBe(0);

    // A stored v2 Scroll draws no picture (#835): T has none to turn into words, and nothing is held. `folio-v3-smoke.spec.ts` has the
    // T key, the Text chips and the held figures on a document v3.
    await expect(page.locator('[data-ks-figure]')).toHaveCount(0);
    await expect(page.locator('[data-testid^="hold-"]')).toHaveCount(0);
  });

  test('a lone figure’s own Text chip turns that one picture into its words, and no other (seasonsV3, a figure with no control)', async ({
    page,
  }) => {
    // The v3 counterpart of the v2 case this file had on the Final call's figure: the figure after seasonsV3's beat b4 stands on its
    // own (no hold, no control), so its chip is its own and does not turn on the reader's text version.
    await open(page, 'seasonsV3', phone);
    const figure = page.getByTestId('figure-figure-b4');
    await figure.scrollIntoViewIfNeeded();
    const plate = figure.locator('[data-ks-figure]');
    const chip = plate.getByRole('button', { name: 'Text version of this picture' });
    const pictures = await page.locator('[data-ks-figure] [role="img"]').count();
    expect(pictures).toBeGreaterThan(1);
    await expect(plate.getByRole('img')).toBeVisible();
    await chip.click();
    await expect(plate.getByRole('img')).toHaveCount(0);
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    // Only that one: every other picture is still drawn.
    await expect(page.locator('[data-ks-figure] [role="img"]')).toHaveCount(pictures - 1);
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

for (const name of ['seasons', 'fenceV3'] as const) {
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

/** The dock of the essay (D-429): every control whole, at least 44 px, on screen, in a row that does not overlap itself. */
for (const { label, viewport, query } of [
  { label: '320 x 568', viewport: { width: 320, height: 568 }, query: {} },
  { label: '390 x 844', viewport: phone, query: {} },
  { label: '1440 x 900', viewport: desktop, query: {} },
  { label: '200 % text at 320 x 568', viewport: { width: 320, height: 568 }, query: { scale: '2' } },
  { label: '200 % text at 390 x 844', viewport: phone, query: { scale: '2' } },
] as { label: string; viewport: { width: number; height: number }; query: Record<string, string> }[]) {
  test(`the dock fits at ${label}: Like, Share, Save, ••• and Part 2, none under 44 px or off the screen`, async ({
    page,
  }) => {
    await open(page, 'seasons', viewport, { ...query, bare: '1' });
    const dock = page.getByTestId('reader-dock');
    await expect(dock).toBeVisible();
    const boxes: { name: string; x: number; y: number; width: number; height: number }[] = [];
    for (const name of ['Like', 'Share a moment', 'Save', 'More', 'Part 2']) {
      const button = dock.getByRole('button', { name: name === 'Part 2' ? /^Part 2/ : name, exact: name !== 'Part 2' });
      // The gallery has no next Part: its dock leaves that control out.
      if (name === 'Part 2' && (await button.count()) === 0) continue;
      const box = (await button.boundingBox())!;
      expect(box.width, `${name} width`).toBeGreaterThanOrEqual(44);
      expect(box.height, `${name} height`).toBeGreaterThanOrEqual(44);
      expect(box.x, `${name} inside left`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${name} inside right`).toBeLessThanOrEqual(viewport.width);
      boxes.push({ name, ...box });
    }
    expect(boxes).toHaveLength(4);
    for (const [index, a] of boxes.entries())
      for (const b of boxes.slice(index + 1)) {
        const apart =
          a.x + a.width <= b.x + 0.5 ||
          b.x + b.width <= a.x + 0.5 ||
          a.y + a.height <= b.y + 0.5 ||
          b.y + b.height <= a.y + 0.5;
        expect(apart, `${a.name} and ${b.name} do not overlap`).toBe(true);
      }
    // The dock sits at the foot of the screen, whole, and the page does not scroll sideways.
    const frame = (await dock.boundingBox())!;
    expect(frame.y + frame.height).toBeLessThanOrEqual(viewport.height + 0.5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await shot(page, `dock-${label.replace(/[^a-z0-9]+/gi, '-')}`);
  });
}

test('the gallery dock toggles Like and Save, each keeping its word', async ({ page }) => {
  await open(page, 'seasons', phone, { bare: '1' });
  const dock = page.getByTestId('reader-dock');
  for (const name of ['Like', 'Save']) {
    await dock.getByRole('button', { name, pressed: false }).click();
    await expect(dock.getByRole('button', { name, pressed: true })).toBeVisible();
    await expect(dock.getByText(name, { exact: true })).toBeVisible();
    await dock.getByRole('button', { name, pressed: true }).click();
    await expect(dock.getByRole('button', { name, pressed: false })).toBeVisible();
  }
});

for (const { label, viewport } of sizes) {
  // The stored v2 seasons (read as text) and the document v3 seasons, whose pictures are drawn and then turned into words.
  for (const name of ['seasons', 'seasonsV3'] as const) {
    test(`axe finds nothing serious or critical on ${name} at ${label}`, async ({ page }) => {
      await open(page, name, viewport);
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
}

/** The beat's top, in px under the top of the scroller, once the place has settled. */
const settledTop = async (page: Page, selector: string) => {
  await page.waitForTimeout(800);
  return (await boxIn(page, selector))?.top ?? Number.NaN;
};

/** The ids of a fixture's stops (a v2 Scroll's) or beats (a document v3's): what `?stop=` and `data-ks-stop` name. */
const unitIds = (name: Name): string[] => {
  const document = documents[name];
  return 'stops' in document ? document.stops.map((stop) => stop.id) : beatsOfV3(document).map((beat) => beat.id);
};

for (const { label, viewport } of sizes) {
  const cases: { name: Name; stop: string | undefined }[] = [
    { name: 'seasons', stop: seasons.stops[Math.floor(seasons.stops.length / 2)]?.id },
    { name: 'seasons', stop: 'closest-in-january' },
    { name: 'seasons', stop: 'equinox' },
    { name: 'seasons', stop: 'solstices' },
    { name: 'seasons', stop: 'the-year' },
    // The beats of seasonsV3 inside a hold (the second of the first hold, the second of the last), where a pinned figure
    // holds the figure above the band at a phone: the v2 stops above were in holds too, before they stopped drawing a figure (#835).
    { name: 'seasonsV3', stop: 'b2' },
    { name: 'seasonsV3', stop: 'b10' },
  ];
  for (const { name, stop } of cases) {
    test(`?stop=${String(stop)} opens ${name} with that beat in view and read, at ${label}`, async ({ page }) => {
      if (stop === undefined) throw new Error('the document has a middle stop');
      expect(unitIds(name)).toContain(stop);
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
      // What the reader said it was reading while opening is the kept stop, then what is on screen once the page settles:
      // never a stop far down the essay.
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

test('a scroll made while an opened stop is kept in place is read once the place is let go', async ({ page }) => {
  // Opening at a stop keeps it in place while the page settles, up to 4 s or until the person's own input, and the scroll
  // is not followed meanwhile. A scroll the page makes (not the person's input) lands while it is kept; when the reader
  // lets go, the beat at the reading line is the one being read, with no further scroll (#769, D-434).
  const opened = Date.now();
  await open(page, 'seasons', { width: 390, height: 844 }, { stop: 'equinox' });
  await scroller(page).evaluate((node) => {
    const stop = node.querySelector('[data-ks-stop="steeper-light"]');
    if (stop === null) throw new Error('no stop steeper-light');
    const band = Math.round(node.clientHeight * 0.42);
    node.scrollTop += stop.getBoundingClientRect().top - node.getBoundingClientRect().top - band + 1;
  });
  await page.waitForTimeout(300);
  // While the place is kept the reader still says it is reading the stop it opened at (when opening took less than the
  // 4 s the place is kept, which is what makes this test about letting it go).
  if (Date.now() - opened < 3_000) expect((await galleryEvents(page)).stops.at(-1)).toBe('equinox');
  await expect.poll(async () => (await galleryEvents(page)).stops.at(-1), { timeout: 8_000 }).toBe('steeper-light');
});

test('a stop the document does not have opens the essay at its start and is never reported', async ({ page }) => {
  await open(page, 'seasons', { width: 390, height: 844 }, { stop: 'no-such-stop' });
  const top = await scroller(page).evaluate((node) => node.scrollTop);
  expect(top).toBe(0);
  const { stops } = await galleryEvents(page);
  expect(stops).not.toContain('no-such-stop');
  expect(stops[0]).toBe(seasons.stops[0]?.id);
});

/** The covers board (`?covers=1`): the cover of a Scroll in each of its cases, in either appearance. */
const coverIds = ['first', 'no-stage', 'text-only', 'continue', 'last'] as const;
const coverFrame = (page: Page, id: (typeof coverIds)[number]) => page.getByTestId(`cover-fixture-${id}`);

async function openCovers(
  page: Page,
  viewport: { width: number; height: number },
  appearance: 'light' | 'dark',
  query: Record<string, string> = {},
) {
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    ['ks.device.preferences', JSON.stringify({ appearance })] as const,
  );
  await page.setViewportSize(viewport);
  await page.goto(`/gallery-folio?${new URLSearchParams({ covers: '1', bare: '1', ...query }).toString()}`);
  await expect(page.getByTestId('cover-board')).toBeVisible();
  await expect(coverFrame(page, 'first').getByRole('heading', { level: 1 })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-ks-appearance')))
    .toBe(appearance);
}

const coverAxe = async (page: Page) => {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(' | ')}`);
};

for (const appearance of ['light', 'dark'] as const) {
  for (const { label, viewport } of sizes) {
    test(`the covers board has no serious accessibility violation in ${appearance} at ${label}`, async ({ page }) => {
      await openCovers(page, viewport, appearance);
      for (const id of coverIds) await expect(coverFrame(page, id)).toBeAttached();
      expect(await coverAxe(page), `axe on the covers board in ${appearance}`).toEqual([]);
      await shot(page, `covers-${appearance}-${label}`);
    });
  }

  test(`each cover is its Scroll's page, in ${appearance}`, async ({ page }) => {
    await openCovers(page, phone, appearance);
    const ground = { light: 'rgb(255, 251, 240)', dark: 'rgb(23, 21, 15)' } as const;
    await expect(coverFrame(page, 'first').getByTestId('essay-cover-first')).toHaveCSS(
      'background-color',
      ground[appearance],
    );
  });
}

test('a cover offers Previous (disabled on the first), Next, Read and the strip, and the opening is no control of its own', async ({
  page,
}) => {
  await openCovers(page, phone, 'light');
  const names = async (id: (typeof coverIds)[number]) =>
    (await coverFrame(page, id).getByRole('button').allInnerTexts()).length;
  // Every cover: Previous and Next above, Read and the strip below. On the first, Previous is there but disabled, so a
  // keyboard user who goes back to it keeps their focus.
  expect(await names('first')).toBe(4);
  expect(await names('no-stage')).toBe(4);
  await expect(coverFrame(page, 'first').getByRole('button', { name: 'Previous cover' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await expect(coverFrame(page, 'no-stage').getByRole('button', { name: 'Previous cover' })).toBeVisible();
  await expect(coverFrame(page, 'continue').getByRole('button', { name: /^Continue / })).toBeVisible();
  await expect(coverFrame(page, 'first').getByRole('button', { name: /^Read / })).toBeVisible();
  await expect(coverFrame(page, 'last').getByText('MORE COVERS', { exact: true })).toBeVisible();
  await expect(coverFrame(page, 'first').getByText(/^NEXT · /)).toBeVisible();
  // Tab goes from Next to Read to the strip: the opening and the picture are not stops.
  const first = coverFrame(page, 'first');
  await first.getByRole('button', { name: 'Next cover' }).focus();
  await page.keyboard.press('Tab');
  await expect(first.getByRole('button', { name: /^Read / })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(first.getByTestId('essay-cover-next')).toBeFocused();
  // The figure's plate has no Text chip and nothing to press.
  await expect(first.getByTestId('essay-cover-figure')).toBeVisible();
  await expect(first.getByText('Text', { exact: true })).toHaveCount(0);
  await expect(first.getByTestId('essay-cover-figure').getByRole('button')).toHaveCount(0);
  await expect(first.getByTestId('essay-cover-figure').getByRole('slider')).toHaveCount(0);
  await expect(coverFrame(page, 'no-stage').getByTestId('essay-cover-figure')).toHaveCount(0);
  await expect(coverFrame(page, 'text-only').getByTestId('essay-cover-figure')).toHaveCount(0);
});

test('the buttons and a tap on the opening or the picture do what they say', async ({ page }) => {
  await openCovers(page, phone, 'light');
  const first = coverFrame(page, 'first');
  await first.getByRole('button', { name: /^Read / }).click();
  await first.getByRole('heading', { level: 1 }).click();
  await first.getByTestId('essay-cover-figure').click();
  await first.getByRole('button', { name: 'Next cover' }).click();
  await first.getByTestId('essay-cover-next').click();
  await coverFrame(page, 'no-stage').getByRole('button', { name: 'Previous cover' }).click();
  expect((await galleryEvents(page)).covers).toEqual([
    'first:open',
    'first:open',
    'first:open',
    'first:next',
    'first:next',
    'no-stage:previous',
  ]);
});

test('a cover is never cut off: at 200 % text on a small phone the figure is dropped and the cover scrolls to its strip', async ({
  page,
}) => {
  await openCovers(page, { width: 320, height: 568 }, 'light', { scale: '2' });
  const first = coverFrame(page, 'first');
  await expect(first.getByTestId('essay-cover-figure')).toHaveCount(0);
  const scrolls = await first.getByTestId('essay-cover-first').evaluate((cover) => {
    const inner = [...cover.querySelectorAll('*')].find(
      (node) => node.scrollHeight > node.clientHeight + 1 && getComputedStyle(node).overflowY !== 'visible',
    );
    return inner !== undefined;
  });
  expect(scrolls).toBe(true);
  const strip = first.getByTestId('essay-cover-next');
  await strip.scrollIntoViewIfNeeded();
  await expect(strip).toBeInViewport();
  const box = await strip.boundingBox();
  const cover = await first.getByTestId('essay-cover-first').boundingBox();
  expect(box && cover && box.y + box.height <= cover.y + cover.height + 1).toBe(true);
  const sizesNow = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }));
  expect(sizesNow.page).toBeLessThanOrEqual(sizesNow.inner);
  expect(await coverAxe(page)).toEqual([]);
});

test('the gallery build carries the Folio gallery marker (the control for the production export check)', () => {
  expect(exportCarries(join(__dirname, '..', 'dist-gallery'), 'ks-folio-gallery')).toBe(true);
});
