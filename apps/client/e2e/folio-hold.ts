import type { Page } from '@playwright/test';

/**
 * Measuring a held figure in the Folio gallery (`/gallery-folio`): where the first hold's figure and beats are, step by
 * step down the essay. Shared by the specs that test holds on a document; it reads the page only, so it serves a v2 or a
 * document v3 essay alike.
 */

const scroller = (page: Page) => page.getByTestId('folio-scroller');

/** Where the first hold's figure and beats are at one step of the scroll, in px from the top of the scroller. */
export interface HoldRow {
  scrollTop: number;
  viewport: number;
  figureTop: number;
  figureBottom: number;
  figureLeft: number;
  /** The state the held figure shows (`data-ks-figure` names the picture and its state). */
  key: string;
  /** How the held figure last changed: `tween`, `crossfade` or `none`. Empty when the page does not say. */
  transition: string;
  firstBeatTop: number;
  lastBeatTop: number;
  beatsRight: number;
}

/** How far each step of {@link throughTheFirstHold} scrolls. */
export const HOLD_STEP = 60;

/** The first hold as the page has it now. Throws when the page has none. */
export async function holdRow(page: Page): Promise<HoldRow> {
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
    // A kit's plate carries the transition itself; a document v3 picture carries it on the drawing inside the plate.
    const drawn = plate.matches('[data-ks-figure-transition]')
      ? plate
      : plate.querySelector('[data-ks-figure-transition]');
    return {
      scrollTop: root.scrollTop,
      viewport: root.clientHeight,
      figureTop: figure.top - frame.top,
      figureBottom: figure.bottom - frame.top,
      figureLeft: figure.left,
      key: plate.getAttribute('data-ks-figure') ?? '',
      transition: drawn?.getAttribute('data-ks-figure-transition') ?? '',
      firstBeatTop: first.top - frame.top,
      lastBeatTop: (beats.at(-1) ?? first).top - frame.top,
      beatsRight: Math.max(...beats.map((box) => box.right)),
    };
  });
}

/** Steps the scroller down from the top until the first hold's figure has left, and records each step. */
export async function throughTheFirstHold(page: Page): Promise<HoldRow[]> {
  const rows: HoldRow[] = [];
  const most = await scroller(page).evaluate((node) => node.scrollHeight - node.clientHeight);
  for (let top = 0; top <= most; top += HOLD_STEP) {
    await scroller(page).evaluate((node, value) => {
      node.scrollTop = value;
    }, top);
    // The held figure follows the scroll through React state: give it a frame or two.
    await page.waitForTimeout(200);
    const row = await holdRow(page);
    rows.push(row);
    if (row.figureBottom < -40) break;
  }
  return rows;
}
