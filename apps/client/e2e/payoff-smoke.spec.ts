import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import { encounterFixture, type EncounterFixtureOptions, readCover } from './encounter-fixture';

/**
 * The end of a v2 Scroll in the production export: the summary, the limits one tap away as "Small print", the ways
 * on (Part 2, Next idea, Close) as buttons the person presses, and nothing that moves on by itself. The document is the
 * labelled CI fixture `seasons-stage-ci` (not product content) served by authored HTTP fixtures, so this proves what the
 * screen does, not the backend. With `KS_PAYOFF_SHOTS` set to a folder, each view also saves a screenshot there (for the
 * PR; never inside the repository).
 */
const phone = { width: 390, height: 844 };
const desktop = { width: 1440, height: 900 };
const small = { width: 320, height: 640 };

const shotsFolder = process.env['KS_PAYOFF_SHOTS'];
async function shoot(page: Page, name: string) {
  if (shotsFolder === undefined) return;
  mkdirSync(shotsFolder, { recursive: true });
  await page.screenshot({ path: join(shotsFolder, `${name}.png`) });
}

async function open(page: Page, viewport = phone, play: EncounterFixtureOptions['play'] = {}) {
  const served = await encounterFixture(page, 'scroll', {
    series: true,
    viewport,
    scrollDocument: seasons as unknown as Record<string, unknown>,
    play,
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

async function audit(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(' | ')}`);
}

const reader = (page: Page) => page.getByRole('group', { name: 'Scroll reader' });
const plate = (page: Page) => page.getByTestId('end-plate');
const partTitle = (page: Page, part: number) =>
  page.getByTestId('reader-top-title').getByRole('heading', { level: 1, name: `CI encounter fixture ${String(part)}` });

/**
 * Goes to the end, as a person who pressed End, and waits until the scroll has arrived: the scroll is smooth, and a plate
 * taller than the screen passes through the view on its way to the bottom.
 */
async function toTheEnd(page: Page) {
  await reader(page).focus();
  await page.keyboard.press('End');
  const scroller = page.getByTestId('folio-scroller');
  await expect
    .poll(() => scroller.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight))
    .toBeLessThan(2);
  await expect(plate(page).getByText('To sum up')).toBeVisible();
}

for (const viewport of [phone, desktop]) {
  const size = `${String(viewport.width)} × ${String(viewport.height)}`;
  const name = `${String(viewport.width)}x${String(viewport.height)}`;

  test(`the end plate sums up and every way on as a button, and nothing moves on by itself, at ${size}`, async ({
    page,
  }) => {
    const served = await open(page, viewport);
    await toTheEnd(page);
    await expect(plate(page).getByRole('button', { name: /^Part 2 · / })).toBeVisible();
    await expect(plate(page).getByRole('button', { name: 'Next idea', exact: true })).toBeVisible();
    await expect(plate(page).getByRole('button', { name: 'Close', exact: true })).toBeVisible();
    await shoot(page, `end-plate-${name}`);

    // The plate waits: the same Scroll, the same address, and not one more request.
    const url = page.url();
    const before = served.commands.length;
    await page.waitForTimeout(4_000);
    expect(page.url()).toBe(url);
    await expect(plate(page).getByText('To sum up')).toBeVisible();
    await expect(partTitle(page, 1)).toBeVisible();
    expect(served.commands.length).toBe(before);
    expect(await audit(page)).toEqual([]);
  });
}

test('Small print opens the limits aside on the end plate where the person is, and closes again', async ({ page }) => {
  await open(page, phone);
  await toTheEnd(page);
  await expect(page.getByTestId('end-small-print')).toHaveCount(0);
  const smallPrint = plate(page).getByRole('button', { name: 'Small print', exact: true });
  await expect(smallPrint).toHaveAttribute('aria-expanded', 'false');
  await smallPrint.click();
  await expect(smallPrint).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('end-small-print')).toContainText('Where this stops');
  await expect(page.getByTestId('end-small-print')).toContainText(/Light sets the season/);
  // It opens in place: the ways on are still there.
  await expect(plate(page).getByRole('button', { name: 'Next idea', exact: true })).toBeVisible();
  await shoot(page, 'end-plate-small-print-390x844');
  expect(await audit(page)).toEqual([]);
  await smallPrint.click();
  await expect(smallPrint).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('end-small-print')).toHaveCount(0);
});

/** Reads the opening for a while and lets the recorder's periodic report fall due, as a person who has been reading. */
async function readForAWhile(page: Page, play: EncounterFixtureOptions['play']) {
  await page.clock.install();
  const served = await open(page, phone, play);
  // Real time, so the first screen is measured before the fake clock moves on.
  await page.waitForTimeout(100);
  await page.clock.fastForward(3_000);
  // The recorder reports every 15 s while it has something to say.
  await page.clock.fastForward(16_000);
  return served;
}

test('with recording on, a while of reading reaches the recorder', async ({ page }) => {
  const { observed } = await readForAWhile(page, {});
  await expect.poll(() => observed.map((event) => event.kind)).toContain('scroll.block_coverage');
});

test('with recording paused the essay still reads and the end plate still leads on, and nothing is reported', async ({
  page,
}) => {
  const { observed } = await readForAWhile(page, { recordingPaused: true });
  // Nothing is sent, so there is nothing to wait for: the report above is where it would have gone (the test before
  // shows the same reading arriving when recording is on).
  await page.waitForTimeout(500);
  expect(observed).toEqual([]);
  await toTheEnd(page);
  await expect(plate(page).getByRole('button', { name: 'Small print', exact: true })).toBeVisible();
  await shoot(page, 'end-plate-paused-390x844');
  expect(await audit(page)).toEqual([]);
  await plate(page)
    .getByRole('button', { name: /^Part 2 · / })
    .click();
  await expect(partTitle(page, 2)).toBeVisible();
});

test('on a 320 px screen the end plate and the dock fit, and the page does not scroll sideways', async ({ page }) => {
  await open(page, small);
  await toTheEnd(page);
  for (const button of await plate(page).getByRole('button').all()) {
    const box = await button.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= small.width, await button.innerText()).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // The dock keeps every control on the screen at 320 px, the way on included.
  await expect(page.getByRole('button', { name: /^Part 2/ }).first()).toBeInViewport({ ratio: 1 });
  // At the end a moment is none, so Share shares the whole Scroll (its name says so); it is still the same button.
  for (const name of ['Like', 'Share this Scroll', 'Save', 'More'])
    await expect(page.getByTestId('reader-dock').getByRole('button', { name, exact: true })).toBeInViewport({
      ratio: 1,
    });
  await shoot(page, 'end-plate-320x640');
  expect(await audit(page)).toEqual([]);
});

test('with reduced motion the end plate is drawn in its final state, and no tilt control or journey picture is left (#835)', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, phone);
  // The fixture's Final call stores the tilt control and its stage is Earth & sky's; neither is drawn or acted on any more.
  await expect(page.getByRole('slider', { name: 'Earth’s tilt' })).toHaveCount(0);
  await toTheEnd(page);
  await expect(plate(page).getByRole('button', { name: /^Part 2 · / })).toBeVisible();
  await expect(plate(page).getByTestId('end-figure')).toHaveCount(0);
  expect(await audit(page)).toEqual([]);
});

for (const viewport of [phone, desktop]) {
  test(`a zero-call Scroll ends and reaches the next Part at ${String(viewport.width)}px`, async ({ page }) => {
    const stops = seasons.stops.filter((stop) => stop.kind === 'read');
    const document = {
      ...seasons,
      stops,
      asides: seasons.asides.map((aside) =>
        aside.kind === 'limits' ? { ...aside, anchorStop: stops.at(-2)!.id } : aside,
      ),
    };
    const served = await encounterFixture(page, 'scroll', { series: true, viewport, scrollDocument: document });
    await page.goto('/explore');
    await readCover(page);
    await expect(
      page.getByTestId('reader-top-title').getByRole('heading', { level: 1, name: 'CI encounter fixture 1' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Got it' }).click();
    await toTheEnd(page);
    // With no call in it there is nothing to challenge a friend with: the sheet has no such row.
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await expect(page.getByTestId('more-list')).toBeVisible();
    await expect(page.getByTestId('more-list').getByRole('button', { name: 'Challenge a friend' })).toHaveCount(0);
    await page.getByRole('dialog', { name: 'More' }).getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'More' })).toHaveCount(0);
    await shoot(page, `zero-calls-end-${viewport.width}`);
    expect(served.commands.filter((command) => command.path === '/v1/play/calls/lock')).toEqual([]);
    await plate(page)
      .getByRole('button', { name: /^Part 2 · / })
      .click();
    await expect(partTitle(page, 2)).toBeVisible();
  });
}
