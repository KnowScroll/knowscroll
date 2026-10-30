import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import { encounterFixture, type EncounterFixtureOptions } from './encounter-fixture';

/**
 * Play on a v2 Scroll in the production export (D-063, D-064, D-083, D-180): pick, lock it in, the
 * reveal ("Called it!" with a spark, or "Plot twist!" with the sourced common guess), the sparks in
 * the dock, results that come back after a reload, and a paused recording. The document is the
 * labelled CI fixture `seasons-stage-ci` (not product content) and the play routes are authored HTTP
 * fixtures that judge from it, so this proves what the screen does with the answers, not the backend
 * (`tests/integration/modules/play.test.ts` is the backend).
 */
const phone = { width: 390, height: 844 };
const desktop = { width: 1440, height: 900 };

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

const firstCall = (page: Page) => page.getByRole('group', { name: 'Call it 1 of 3' });
const secondCall = (page: Page) => page.getByRole('group', { name: 'Call it 2 of 3' });
/** The dock's chip says how many sparks this Scroll has earned, in words. */
const sparksIn = (page: Page, count: number) =>
  expect(page.getByTestId('spark-chip')).toHaveAttribute(
    'aria-label',
    count === 1 ? '1 spark' : `${String(count)} sparks`,
  );
const lockRequests = (served: Awaited<ReturnType<typeof open>>) =>
  served.commands.filter((command) => command.path === '/v1/play/calls/lock');

async function goToCall(page: Page, name: string) {
  await page.getByRole('button', { name, exact: true }).click();
}

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

  test(`a right pick shows "Called it!" with a spark in the dock, at ${size}`, async ({ page }) => {
    const served = await open(page, viewport);
    await sparksIn(page, 0);
    await goToCall(page, 'Call it 1 of 3');
    const lock = firstCall(page).getByRole('button', { name: 'Lock it in' });
    await expect(lock).toBeDisabled();
    await page.getByRole('radio', { name: /Delhi’s half/ }).click();
    await lock.click();
    await expect(page.getByText('Called it!')).toBeVisible();
    await expect(page.getByText('+1 spark')).toBeVisible();
    await expect(page.getByText('Plot twist!')).toHaveCount(0);
    // The reveal is the moment: it is brought wholly on screen, not left below the fold.
    await expect(page.getByTestId('call-reveal')).toBeInViewport({ ratio: 0.99 });
    await sparksIn(page, 1);
    // What was sent is the lock and nothing the client judged: no correctness, no spark.
    await expect.poll(() => lockRequests(served).length).toBe(1);
    expect(Object.keys(lockRequests(served)[0]!.body).sort()).toEqual([
      'assetId',
      'commandId',
      'option',
      'recordingGeneration',
      'revision',
      'stopId',
    ]);
    expect(await audit(page)).toEqual([]);
  });

  test(`a wrong pick is a Plot twist with the sourced common guess and no spark, at ${size}`, async ({ page }) => {
    await open(page, viewport);
    await goToCall(page, 'Call it 1 of 3');
    await page.getByRole('radio', { name: /Earth is closer to the Sun in June/ }).click();
    await firstCall(page).getByRole('button', { name: 'Lock it in' }).click();
    await expect(page.getByText('Plot twist!')).toBeVisible();
    // On a phone the reveal is taller than the text, so what is brought on screen is its label first.
    await expect(page.getByText('Plot twist!')).toBeInViewport();
    await expect(page.getByText('You called: Earth is closer to the Sun in June')).toBeVisible();
    await expect(page.getByText("You're in good company")).toBeVisible();
    await expect(page.getByText(/The common guess\. Source: A Private Universe/)).toBeVisible();
    await expect(page.getByText('Called it!')).toHaveCount(0);
    await expect(page.getByText('+1 spark')).toHaveCount(0);
    await sparksIn(page, 0);
    expect(await audit(page)).toEqual([]);
  });
}

test('two right calls in a row build a combo, and a wrong call after them keeps the sparks', async ({ page }) => {
  await open(page);
  await goToCall(page, 'Call it 1 of 3');
  await page.getByRole('radio', { name: /Delhi’s half/ }).click();
  await firstCall(page).getByRole('button', { name: 'Lock it in' }).click();
  await goToCall(page, 'Call it 2 of 3');
  await page.getByRole('radio', { name: /The southern half/ }).click();
  await secondCall(page).getByRole('button', { name: 'Lock it in' }).click();
  await expect(page.getByText('Combo ×2')).toBeVisible();
  await sparksIn(page, 2);
});

test('results come back after a reload: the call is already revealed and the dock has its sparks', async ({ page }) => {
  await open(page, phone, { kept: [{ stopId: 'call-delhi', option: 1 }] });
  await sparksIn(page, 1);
  await goToCall(page, 'Call it 1 of 3');
  await expect(page.getByText('Called it!')).toBeVisible();
  await expect(firstCall(page).getByRole('button', { name: 'Lock it in' })).toHaveCount(0);
  await expect(page.getByRole('radio', { name: /Delhi’s half/ })).toBeDisabled();
});

test('a Plot twist that was kept comes back as a Plot twist, with no spark', async ({ page }) => {
  await open(page, phone, { kept: [{ stopId: 'call-delhi', option: 0 }] });
  await sparksIn(page, 0);
  await goToCall(page, 'Call it 1 of 3');
  await expect(page.getByText('Plot twist!')).toBeVisible();
});

test('with recording paused, play works on the device, sends nothing to keep and says so', async ({ page }) => {
  const served = await open(page, phone, { recordingPaused: true });
  await goToCall(page, 'Call it 1 of 3');
  await expect(firstCall(page).getByText('Not saved while recording is paused.')).toBeVisible();
  await page.getByRole('radio', { name: /Delhi’s half/ }).click();
  await firstCall(page).getByRole('button', { name: 'Lock it in' }).click();
  await expect(page.getByText('Called it!')).toBeVisible();
  await sparksIn(page, 1);
  await expect(page.getByTestId('call-reveal')).toContainText('Not saved while recording is paused.');
  expect(lockRequests(served)).toEqual([]);
  expect(await audit(page)).toEqual([]);
});

test('keys play the call: a number picks, Enter locks it in', async ({ page }) => {
  await open(page);
  await goToCall(page, 'Call it 1 of 3');
  await page.getByRole('group', { name: 'Scroll reader' }).focus();
  await page.keyboard.press('2');
  await expect(page.getByRole('radio', { name: /Delhi’s half/ })).toBeChecked();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Called it!')).toBeVisible();
  await sparksIn(page, 1);
});
