import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import blocks from '@knowscroll/scroll-model/fixtures/scale-chart-blocks-ci.json';
import { encounterFixture, id } from './encounter-fixture';

/**
 * Moving between Parts and topics in the Scroll reader (#497, part B) in the production export over labelled HTTP fixtures:
 * the next Part coming in under the finger, the bar and the tab it arrives with, the pull meter at the end, and the note
 * after Next ↑. The document is the labelled CI fixture `seasons-stage-ci` (not product content). Screenshots are written
 * only when `KS_FIDELITY_SHOTS` names a folder (outside the repository).
 */
const phone = { width: 390, height: 844 };
const desktop = { width: 1440, height: 900 };

test.use({ hasTouch: true });

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
  await expect(page.getByRole('heading', { level: 1, name: 'CI encounter fixture 1' })).toBeVisible();
  await page.getByRole('button', { name: 'Got it' }).click();
  return served;
}

type Point = { x: number; y: number };

/** A finger that can be held part of the way, as the browser's own touch events. */
class Finger {
  private constructor(
    private readonly cdp: CDPSession,
    private at: Point,
  ) {}
  static async down(page: Page, from: Point) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
    return new Finger(cdp, from);
  }
  async to(to: Point) {
    for (let step = 1; step <= 6; step += 1) {
      const along = step / 6;
      const point = { x: this.at.x + (to.x - this.at.x) * along, y: this.at.y + (to.y - this.at.y) * along };
      await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point] });
    }
    this.at = to;
  }
  async up() {
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await this.cdp.detach();
  }
}

const centre = async (page: Page): Promise<Point> => {
  const box = await page.getByTestId('stop-scroller').boundingBox();
  if (box === null) throw new Error('the text is on the page');
  return { x: box.x + box.width * 0.6, y: box.y + box.height / 2 };
};

async function scrollToTheEnd(page: Page) {
  const scroller = page.getByTestId('stop-scroller');
  await scroller.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect
    .poll(() => scroller.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight))
    .toBeLessThan(4);
}

const heading = (page: Page) => page.getByRole('heading', { level: 1 });

test('the next Part comes in under the finger, past the notch it says so, and a release opens it with its bar and tab', async ({
  page,
}) => {
  await open(page);
  const start = await centre(page);
  const finger = await Finger.down(page, start);
  await finger.to({ x: start.x - 30, y: start.y });
  await expect(page.getByTestId('part-peek-panel')).toBeVisible();
  await expect(page.getByTestId('part-peek-words')).toContainText('KEEP GOING · PART 2');
  await finger.to({ x: start.x - 110, y: start.y });
  await expect(page.getByTestId('part-peek-words')).toContainText('PAST THE NOTCH · LET GO TO CONTINUE');
  await shot(page, 'drag-390x844');
  expect(await audit(page)).toEqual([]);
  await finger.up();
  await expect(heading(page)).not.toHaveText('CI encounter fixture 1');
  await expect(page.getByTestId('part-arrival')).toHaveText('Part 2 · your place in Part 1 is kept');
  await expect(page.getByTestId('part-peek-panel')).toHaveCount(0);
  const tab = page.getByTestId('part-back-tab');
  await expect(tab).toBeVisible();
  await shot(page, 'part-2-arrived-390x844');
  expect(await audit(page)).toEqual([]);
  await tab.click();
  await expect(heading(page)).toHaveText('CI encounter fixture 1');
});

test('a short drag shows the Part coming and puts it back: nothing opens', async ({ page }) => {
  await open(page);
  const start = await centre(page);
  const finger = await Finger.down(page, start);
  await finger.to({ x: start.x - 40, y: start.y });
  await expect(page.getByTestId('part-peek-panel')).toBeVisible();
  await finger.to({ x: start.x - 3, y: start.y });
  await finger.up();
  await expect(page.getByTestId('part-peek-panel')).toHaveCount(0);
  await expect(heading(page)).toHaveText('CI encounter fixture 1');
});

test('a drag with nothing admitted behind it shows nothing: the first Part has none before it', async ({ page }) => {
  await open(page);
  const start = await centre(page);
  const finger = await Finger.down(page, start);
  await finger.to({ x: start.x + 120, y: start.y });
  await expect(page.getByTestId('part-peek-panel')).toHaveCount(0);
  await finger.up();
});

test('under reduced motion nothing slides: the Part opens with the same bar and tab', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  const start = await centre(page);
  const finger = await Finger.down(page, start);
  await finger.to({ x: start.x - 110, y: start.y });
  await expect(page.getByTestId('part-peek-panel')).toHaveCount(0);
  await finger.up();
  await expect(page.getByTestId('part-arrival')).toHaveText('Part 2 · your place in Part 1 is kept');
  await expect(page.getByTestId('part-back-tab')).toBeVisible();
});

test('the button opens the Part the same way, with the same bar and tab', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: /^Part 2: / }).click();
  await expect(page.getByTestId('part-arrival')).toBeVisible();
  await expect(page.getByTestId('part-back-tab')).toBeVisible();
});

test('the end tray has a handle whose meter fills with the pull, and a short pull moves nothing', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'The end of this Scroll', exact: true }).click();
  await scrollToTheEnd(page);
  await expect(page.getByTestId('pull-handle')).toBeVisible();
  const fill = page.getByTestId('pull-meter-fill');
  const width = () => fill.evaluate((node) => node.getBoundingClientRect().width);
  expect(await width()).toBe(0);
  const start = await centre(page);
  const finger = await Finger.down(page, start);
  await finger.to({ x: start.x, y: start.y - 48 });
  await expect.poll(width).toBeGreaterThan(5);
  const half = await width();
  await finger.to({ x: start.x, y: start.y - 80 });
  await expect.poll(width).toBeGreaterThan(half);
  await shot(page, 'pull-390x844');
  await finger.to({ x: start.x, y: start.y - 20 });
  await finger.up();
  await expect.poll(width).toBe(0);
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
  await page.getByRole('button', { name: 'Next topic' }).click();
  await expect(page.getByTestId('format-note')).toBeVisible();
  // Focus is not taken into the note (that would hold its timer for good). The reader has it, as it does on any new Scroll,
  // so the reader's own keys act with no click or Tab first.
  await expect(page.getByTestId('scroll-reader')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(heading(page)).toHaveText('CI encounter fixture 1');
  await expect(page.getByTestId('scroll-reader')).toBeFocused();
  await page.getByRole('button', { name: /^Part 2: / }).click();
  await expect(page.getByTestId('part-arrival')).toBeVisible();
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
  await page.getByTestId('scroll-reader').focus();
  await page.clock.runFor(8_000);
  await expect(note).toBeVisible();
  await page.clock.runFor(1_500);
  await expect(note).toHaveCount(0);
  // Focus was not in the note when it went, so it was not pulled anywhere.
  await expect(page.getByTestId('scroll-reader')).toBeFocused();
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
  await expect(page.getByTestId('part-arrival')).toHaveCount(0);
  await expect(page.getByTestId('part-back-tab')).toHaveCount(0);
  await page.getByRole('button', { name: /^Part 2: / }).click();
  await expect(page.getByTestId('part-arrival')).toHaveText('Part 2 · your place in Part 1 is kept');
  await expect(page.getByTestId('part-back-tab')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/scroll/${id(301)}$`));
  await page.reload();
  await expect(page.getByTestId('scroll-reader')).toBeVisible();
  await expect(page.getByTestId('part-arrival')).toHaveCount(0);
  // The tab is the Part before, kept in view whenever one was admitted.
  await expect(page.getByTestId('part-back-tab')).toBeVisible();
});

/** A labelled v2 CI document with no pinned picture, as Seasons Part 3 has none. */
const pictureless = blocks as unknown as Record<string, unknown>;

for (const { label, viewport } of [
  { label: '390 × 844', viewport: phone },
  { label: '1440 × 900', viewport: desktop },
]) {
  test(`at ${label} the back tab of a Part with no picture has a row of its own and covers none of the text (#648)`, async ({
    page,
  }) => {
    await encounterFixture(page, 'scroll', { viewport, direct: { parts: 3 }, scrollDocument: pictureless });
    await page.goto(`/scroll/${id(301)}`);
    await expect(page.getByTestId('scroll-reader')).toBeVisible();
    const tab = page.getByTestId('part-back-tab');
    await expect(tab).toBeVisible();
    await expect(page.getByTestId('part-back-tab-row')).toBeVisible();
    const tabBox = (await tab.boundingBox())!;
    // The first stop's text starts below the tab, not under it.
    const firstText = (await page.getByTestId('stop-scroller').boundingBox())!;
    expect(tabBox.y + tabBox.height).toBeLessThanOrEqual(firstText.y + 1);
    await shot(page, `part-back-tab-no-picture-${String(viewport.width)}`);
    expect(await audit(page)).toEqual([]);
    await tab.click();
    await expect(page).toHaveURL(new RegExp(`/scroll/${id(300)}$`));
  });
}

test('a related move opens its Scroll without saying a place in a Part was kept', async ({ page }) => {
  await encounterFixture(page, 'scroll', {
    viewport: phone,
    direct: { parts: 3, related: true },
    scrollDocument: seasons as unknown as Record<string, unknown>,
  });
  await page.goto(`/scroll/${id(300)}`);
  await expect(page.getByTestId('scroll-reader')).toBeVisible();
  // The related move is at the end of the Scroll, beside the next Part; the Scroll it opens is counted in a series too.
  await page.getByRole('button', { name: 'The end of this Scroll', exact: true }).click();
  await page.getByRole('button', { name: /^Another related explanation/ }).click();
  // The fixture's related Scroll is not the next one in the series.
  await expect(page).toHaveURL(new RegExp(`/scroll/${id(305)}$`));
  // Once its context has arrived (the Part before is admitted, so the tab is there) the bar would have been said.
  await expect(page.getByTestId('part-back-tab')).toBeVisible();
  // Never, for as long as the bar would last: looked at every 100 ms, so a bar that comes and goes cannot be missed.
  for (let look = 0; look < 40; look += 1) {
    expect(await page.getByTestId('part-arrival').count()).toBe(0);
    await page.waitForTimeout(100);
  }
});

test('F switches to the Reel with no click or Tab first: the reader has focus, not the note', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Next topic' }).click();
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
