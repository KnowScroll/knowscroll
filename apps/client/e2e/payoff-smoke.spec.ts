import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import { encounterFixture, type EncounterFixtureOptions } from './encounter-fixture';

/**
 * The Final call and the payoff at the end of a v2 Scroll in the production export (D-187 to D-189):
 * the tilt of Earth's axis turned on the picture, the combo bonus announced and paid, the gold or
 * plain landmark, the score row, the Part 2 peek and "Done for today" at the same weight, the limits
 * one tap away as "Small print", and nothing that moves on by itself. The document is the labelled CI
 * fixture `seasons-stage-ci` (not product content) and the play routes are authored HTTP fixtures that
 * judge from it, so this proves what the screen does with the answers; the backend is
 * `tests/integration/modules/play.test.ts`. With `KS_PAYOFF_SHOTS` set to a folder, each view also
 * saves a screenshot there (for the PR; never inside the repository).
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
  await expect(page.getByRole('heading', { level: 1, name: 'CI encounter fixture 1' })).toBeVisible();
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

const dot = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const lockRequests = (served: Awaited<ReturnType<typeof open>>) =>
  served.commands.filter((command) => command.path === '/v1/play/calls/lock');
const sparksIn = (page: Page, count: number) =>
  expect(page.getByTestId('spark-chip')).toHaveAttribute(
    'aria-label',
    count === 1 ? '1 spark' : `${String(count)} sparks`,
  );

/** Locks both Call its right (a combo of two), then arrives at the Final call. */
async function playToFinalCall(page: Page) {
  await dot(page, 'Call it 1 of 3').click();
  await page.getByRole('radio', { name: /Delhi’s half/ }).click();
  await page.getByRole('group', { name: 'Call it 1 of 3' }).getByRole('button', { name: 'Lock it in' }).click();
  await dot(page, 'Call it 2 of 3').click();
  await page.getByRole('radio', { name: /The southern half/ }).click();
  await page.getByRole('group', { name: 'Call it 2 of 3' }).getByRole('button', { name: 'Lock it in' }).click();
  await dot(page, 'Final call').click();
  await expect(page.getByRole('group', { name: 'Final call' })).toBeVisible();
}

const lockFinal = (page: Page) =>
  page.getByRole('group', { name: 'Final call' }).getByRole('button', { name: 'Lock it in' }).click();

for (const viewport of [phone, desktop]) {
  const size = `${String(viewport.width)} × ${String(viewport.height)}`;
  const name = `${String(viewport.width)}x${String(viewport.height)}`;

  test(`a right Final call after a combo is paid twice, earns the gold landmark and ends in the payoff, at ${size}`, async ({
    page,
  }) => {
    const served = await open(page, viewport);
    await playToFinalCall(page);
    // Before the lock: what the call is for, what the combo does, and the tilt to turn.
    await expect(page.getByTestId('final-call-gold-note')).toHaveText('Get it first try for the gold landmark');
    await expect(page.getByTestId('final-call-combo')).toHaveText('Combo ×2 doubles this one');
    await expect(page.getByTestId('tilt-value')).toHaveText('23.4°');
    await shoot(page, `final-call-before-${name}`);

    // Turning the tilt redraws the pinned picture and its description at once, and sends nothing.
    const stage = page.getByTestId('stage');
    // The picture is one drawing that the slider redraws: a step of the slider never replaces it.
    await page.waitForTimeout(600);
    const drawing = await stage.locator('svg').first().elementHandle();
    await page.getByRole('slider', { name: 'Earth’s tilt' }).focus();
    await page.keyboard.press('Home');
    await expect(page.getByTestId('tilt-value')).toHaveText('0°');
    await expect(stage).toHaveAttribute('data-ks-stage-tilt', '0');
    await expect(stage.getByRole('img')).toHaveAccessibleName(/stands straight up/);
    await shoot(page, `final-call-tilt-0-${name}`);
    await page.keyboard.press('End');
    await expect(page.getByTestId('tilt-value')).toHaveText('90°');
    await page.keyboard.press('Home');
    expect(await drawing?.evaluate((node) => node.isConnected)).toBe(true);
    expect(lockRequests(served)).toHaveLength(2);

    await page.getByRole('radio', { name: /Every day is like an equinox/ }).click();
    await lockFinal(page);
    await expect(page.getByText('Called it!').last()).toBeVisible();
    await expect(page.getByText('+2 sparks')).toBeVisible();
    await sparksIn(page, 4);
    await expect.poll(() => lockRequests(served).length).toBe(3);
    // What was sent is the lock, and nothing the client judged: no correctness, no spark, no tier, no tilt.
    expect(Object.keys(lockRequests(served)[2]!.body).sort()).toEqual([
      'assetId',
      'commandId',
      'option',
      'recordingGeneration',
      'revision',
      'stopId',
    ]);
    await shoot(page, `final-call-after-${name}`);

    // The end: the score row, the gold landmark, the peek and every way on at once.
    await dot(page, 'The end of this Scroll').click();
    const tray = page.getByTestId('end-tray');
    await expect(tray).toBeVisible();
    const score = page.getByTestId('payoff-score');
    await expect(score).toContainText('4 sparks');
    await expect(score).toContainText('Combo ×3');
    await expect(score).toContainText('Final call ✓');
    const card = page.getByTestId('landmark-card');
    await expect(card).toHaveAttribute('data-ks-landmark-tier', 'gold');
    await expect(card).toContainText('Gold landmark');
    await expect(card).toContainText('The Leaning Axis');
    await expect(page.getByTestId('part-peek')).toContainText('Part 2');
    await shoot(page, `payoff-gold-${name}`);
    // The tray is longer than one screen on a phone: everything in it is reachable by scrolling it.
    await page.getByRole('button', { name: 'Small print', exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: 'Small print', exact: true })).toBeInViewport();
    await shoot(page, `payoff-gold-bottom-${name}`);
    await page.getByTestId('landmark-card').scrollIntoViewIfNeeded();

    // "Done for today" is the same size as "Something new" and as heavy as Continue (a button of its own, not a link).
    const done = await page.getByRole('button', { name: 'Done for today' }).boundingBox();
    const next = await page.getByRole('button', { name: 'Something new' }).boundingBox();
    const keepGoing = await page.getByRole('button', { name: 'Continue Part 2' }).boundingBox();
    expect(done && next && done.height === next.height).toBe(true);
    expect(done && keepGoing && done.height >= keepGoing.height - 4).toBe(true);

    expect(await audit(page)).toEqual([]);
  });

  test(`a wrong Final call still earns the landmark, in its plain finish, at ${size}`, async ({ page }) => {
    const served = await open(page, viewport);
    await playToFinalCall(page);
    await page.getByRole('radio', { name: /The north stays in summer all year/ }).click();
    await lockFinal(page);
    await expect(page.getByText('Plot twist!').last()).toBeVisible();
    await expect(page.getByTestId('landmark-still-earned')).toHaveText(
      'You still earn the landmark, in the plain finish.',
    );
    await expect.poll(() => lockRequests(served).length).toBe(3);
    await dot(page, 'The end of this Scroll').click();
    const card = page.getByTestId('landmark-card');
    await expect(card).toHaveAttribute('data-ks-landmark-tier', 'plain');
    await expect(card).toContainText('The Leaning Axis');
    await expect(card).toContainText('Plain finish.');
    await expect(card).not.toContainText('Gold');
    await expect(page.getByTestId('payoff-score')).toContainText('Final call · Plot twist');
    await shoot(page, `payoff-plain-${name}`);
    expect(await audit(page)).toEqual([]);
  });
}

test('Small print opens the limits aside where the person is, and Done for today closes warmly and lets go only on Close', async ({
  page,
}) => {
  await open(page, phone);
  await playToFinalCall(page);
  await page.getByRole('radio', { name: /Every day is like an equinox/ }).click();
  await lockFinal(page);
  await dot(page, 'The end of this Scroll').click();
  await expect(page.getByTestId('small-print')).toHaveCount(0);
  const smallPrint = page.getByRole('button', { name: 'Small print', exact: true });
  await expect(smallPrint).toHaveAttribute('aria-expanded', 'false');
  await smallPrint.click();
  await expect(smallPrint).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('small-print')).toContainText('Where this stops');
  await expect(page.getByTestId('small-print')).toContainText(/Light sets the season/);
  await expect(page.getByTestId('end-tray')).toBeVisible();
  await shoot(page, 'payoff-small-print-390x844');
  await page.getByRole('button', { name: 'Done for today' }).click();
  await expect(page.getByText('A good place to stop.')).toBeVisible();
  // The button that was pressed is gone, so focus moved to the panel instead of dropping to the page.
  await expect(page.getByTestId('done-for-today')).toBeFocused();
  await expect(page.getByTestId('done-for-today')).toContainText('The Leaning Axis is yours.');
  await shoot(page, 'done-for-today-390x844');
  expect(await audit(page)).toEqual([]);
  await page.getByRole('button', { name: 'Back to the end' }).click();
  await expect(page.getByTestId('landmark-card')).toBeVisible();
  await expect(page.getByTestId('end-tray')).toBeFocused();
});

test('nothing moves on by itself: the payoff waits, on the same Scroll, with no further request', async ({ page }) => {
  const served = await open(page, phone);
  await playToFinalCall(page);
  await page.getByRole('radio', { name: /Every day is like an equinox/ }).click();
  await lockFinal(page);
  await dot(page, 'The end of this Scroll').click();
  const url = page.url();
  const before = served.commands.length;
  await page.waitForTimeout(4_000);
  expect(page.url()).toBe(url);
  await expect(page.getByTestId('end-tray')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'CI encounter fixture 1' })).toBeVisible();
  expect(served.commands.length).toBe(before);
});

test('a Scroll opened again shows the landmark that was kept, already earned, with the Final call revealed', async ({
  page,
}) => {
  await open(page, phone, {
    kept: [
      { stopId: 'call-delhi', option: 1 },
      { stopId: 'call-december', option: 1 },
      { stopId: 'final-tilt', option: 0 },
    ],
  });
  await sparksIn(page, 4);
  await dot(page, 'The end of this Scroll').click();
  await expect(page.getByTestId('landmark-card')).toHaveAttribute('data-ks-landmark-tier', 'gold');
  await expect(page.getByTestId('payoff-score')).toContainText('Final call ✓');
  await dot(page, 'Final call').click();
  await expect(page.getByRole('group', { name: 'Final call' }).getByRole('button', { name: 'Lock it in' })).toHaveCount(
    0,
  );
  await expect(page.getByText('Called it!').last()).toBeVisible();
});

test('with recording paused the Final call works on the device, is not sent, and the payoff says so', async ({
  page,
}) => {
  const served = await open(page, phone, { recordingPaused: true });
  await playToFinalCall(page);
  await expect(
    page.getByRole('group', { name: 'Final call' }).getByText('Not saved while recording is paused.'),
  ).toBeVisible();
  await page.getByRole('radio', { name: /Every day is like an equinox/ }).click();
  await lockFinal(page);
  await expect(page.getByText('Called it!').last()).toBeVisible();
  await dot(page, 'The end of this Scroll').click();
  await expect(page.getByTestId('landmark-card')).toHaveAttribute('data-ks-landmark-tier', 'gold');
  await expect(page.getByTestId('landmark-note')).toHaveText('Not saved while recording is paused.');
  expect(lockRequests(served)).toEqual([]);
  await shoot(page, 'payoff-paused-390x844');
  expect(await audit(page)).toEqual([]);
});

test('a Final call still open at the end offers the way back to it, and no landmark yet', async ({ page }) => {
  await open(page, phone);
  await dot(page, 'The end of this Scroll').click();
  await expect(page.getByTestId('payoff-score')).toContainText('Final call · still open');
  await expect(page.getByTestId('landmark-card')).toHaveCount(0);
  await page.getByRole('button', { name: 'Play the Final call' }).click();
  await expect(page.getByRole('group', { name: 'Final call' })).toBeVisible();
  await expect(page.getByTestId('tilt-control')).toBeVisible();
});

test('on a 320 px screen the picture, the tilt slider and the options all fit, and the page does not scroll sideways', async ({
  page,
}) => {
  await open(page, small);
  await playToFinalCall(page);
  const stage = await page.getByTestId('stage').boundingBox();
  expect(stage && stage.height).toBeGreaterThanOrEqual(176);
  const slider = await page.getByRole('slider', { name: 'Earth’s tilt' }).boundingBox();
  expect(slider && slider.x >= 0 && slider.x + slider.width <= small.width).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // The dock keeps every control on the screen at 320 px, the way on included.
  await expect(page.getByRole('button', { name: /^Part 2/ })).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('button', { name: 'Ask about this', exact: true })).toBeInViewport({ ratio: 1 });
  await shoot(page, 'final-call-320x640');
  expect(await audit(page)).toEqual([]);
});

test('with reduced motion the payoff is drawn in its final state, and a screen reader hears the tilt', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, phone);
  await playToFinalCall(page);
  const slider = page.getByRole('slider', { name: 'Earth’s tilt' });
  await expect(slider).toHaveAttribute('aria-valuenow', '23.4');
  await expect(slider).toHaveAttribute('aria-valuetext', '23.4°');
  await slider.focus();
  await page.keyboard.press('Home');
  await expect(slider).toHaveAttribute('aria-valuetext', '0°');
  await page.getByRole('radio', { name: /Every day is like an equinox/ }).click();
  await lockFinal(page);
  await dot(page, 'The end of this Scroll').click();
  await expect(page.getByTestId('landmark-card')).toBeVisible();
  // The text version describes the tilt that was left on the picture (the end shows the picture as it was built).
  await page.getByRole('button', { name: 'Text version' }).click();
  await expect(page.getByTestId('stage')).toContainText(/Earth’s axis is tilted by 23.4 degrees/);
});
