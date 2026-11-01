import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import {
  FINAL_CALL,
  SCROLL_TARGET,
  challengeWorld,
  openRavi,
  routeAshaSocial,
  type ChallengeWorld,
} from './challenge-fixture';
import { encounterFixture } from './encounter-fixture';

/**
 * Challenge a friend (v3 S-9, D-244, D-245) in the production export, with two people in two browser contexts over
 * labelled HTTP fixtures that keep the real server's rules for the card: nobody sees the other's pick or the right answer
 * before they have called, and a pick is stored only while recording is on (no backend; the backend is
 * `tests/integration/modules/social-challenges.test.ts`). Asha sends the Final call of the labelled CI Scroll
 * `seasons-stage-ci` from its ••• menu; Ravi answers in his conversation. Screenshots are written only when
 * `KS_CHALLENGE_SHOTS` names a folder (outside the repository).
 */
const phone = { width: 390, height: 844 };
const desktop = { width: 1440, height: 900 };
const letters = ['A', 'B', 'C'];

async function shot(page: Page, name: string) {
  const folder = process.env['KS_CHALLENGE_SHOTS'];
  if (folder === undefined) return;
  mkdirSync(folder, { recursive: true });
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(folder, `${name}.png`) });
}

async function audit(page: Page, within?: string) {
  const builder = new AxeBuilder({ page });
  const results = await (within === undefined ? builder : builder.include(within))
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(' | ')}`);
}

/** Asha's reader: the labelled CI Scroll on screen in Explore, with this world's Social routes in front. */
async function openAsha(
  page: Page,
  world: ChallengeWorld,
  viewport: { width: number; height: number },
  options: { recordingPaused?: boolean } = {},
) {
  const served = await encounterFixture(page, 'scroll', {
    viewport,
    scrollDocument: seasons as unknown as Record<string, unknown>,
    ...(options.recordingPaused === true ? { play: { recordingPaused: true } } : {}),
  });
  await routeAshaSocial(page, world);
  await page.goto('/explore');
  await expect(page.getByRole('heading', { level: 1, name: 'CI encounter fixture 1' })).toBeVisible();
  await page.getByRole('button', { name: 'Got it' }).click();
  return served;
}

/** ••• then Challenge a friend: the sheet over the reader. */
async function openSheet(page: Page) {
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByTestId('more-challenge').click();
  const sheet = page.getByRole('dialog', { name: 'Challenge a friend' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('YOUR CALL FIRST')).toBeVisible();
  return sheet;
}

const sends = (world: ChallengeWorld) =>
  world.requests.filter((request) => request.path.endsWith('/conversations/send'));
const locks = (world: ChallengeWorld, who: 'asha' | 'ravi') =>
  world.requests.filter((request) => request.who === who && request.path.endsWith('/challenge/lock'));

for (const viewport of [phone, desktop]) {
  const size = `${String(viewport.width)} × ${String(viewport.height)}`;
  const name = `${String(viewport.width)}x${String(viewport.height)}`;

  test(`two people: a challenge is sent with no pick, stays hidden until both have called, then shows both, at ${size}`, async ({
    browser,
  }) => {
    const world = challengeWorld();
    const ashaContext = await browser.newContext({ viewport });
    const asha = await ashaContext.newPage();
    await openAsha(asha, world, viewport);

    // Asha's sheet: the Final call's own question, her own call first, then a friend.
    const sheet = await openSheet(asha);
    await expect(sheet.getByTestId('challenge-sheet-prompt')).toHaveText(FINAL_CALL.prompt);
    await expect(sheet.getByRole('radio', { name: /^Option A\./ })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Choose a friend' })).toBeDisabled();
    await sheet.getByRole('radio', { name: 'Ravi fixture' }).click();
    // A friend alone is not enough: the sender calls first.
    await expect(sheet.getByRole('button', { name: 'Challenge Ravi fixture' })).toBeDisabled();
    await shot(asha, `challenge-sheet-${name}`);
    await sheet.getByTestId('challenge-pick-1').click();
    expect(await audit(asha)).toEqual([]);
    await sheet.getByRole('button', { name: 'Challenge Ravi fixture' }).click();
    await expect(sheet.getByText('Challenge sent to Ravi fixture')).toBeVisible();
    await expect(
      sheet.getByText('Your call is locked in and hidden. You will both see the answers once you have both called.'),
    ).toBeVisible();
    await shot(asha, `challenge-sent-${name}`);

    // What went over the wire: the stop, and no pick in the card; her own pick in a command of its own, with no answer.
    const [sent] = sends(world);
    expect(sent?.body['body']).toEqual({
      kind: 'content',
      target: SCROLL_TARGET,
      challenge: { stopId: FINAL_CALL.id },
    });
    const [locked] = locks(world, 'asha');
    expect(Object.keys(locked!.body).toSorted()).toEqual([
      'conversation',
      'messageId',
      'option',
      'recordingGeneration',
      'version',
    ]);
    expect(locked!.body).toMatchObject({ option: 1, recordingGeneration: 1 });

    // Ravi opens his conversation: the question, no pick of Asha's, no answer.
    const raviContext = await browser.newContext({ viewport });
    const ravi = await raviContext.newPage();
    await openRavi(ravi, world, viewport);
    await expect(ravi.getByTestId('challenge-prompt')).toHaveText(FINAL_CALL.prompt);
    await expect(ravi.getByTestId('challenge-status')).toHaveText(
      'Call it before you see Asha fixture’s. Both answers show once you have both called.',
    );
    await expect(ravi.getByTestId('challenge-lock')).toBeDisabled();
    await expect(ravi.getByTestId('challenge-explain')).toHaveCount(0);
    await shot(ravi, `challenge-card-open-${name}`);
    expect(await audit(ravi)).toEqual([]);
    for (const { who, json } of world.cardsShown.filter((entry) => entry.who === 'ravi')) {
      expect(who).toBe('ravi');
      expect(json).not.toContain('theirs');
      expect(json).not.toContain('"answer"');
    }

    // Asha has called and waits: her card shows her own call and nothing of Ravi's.
    await asha.getByRole('button', { name: 'Open chat' }).click();
    await expect(asha.getByTestId('challenge-status')).toHaveText(
      'You called B. Ravi fixture’s call shows once they have called too.',
    );
    await expect(asha.getByTestId('challenge-lock')).toHaveCount(0);
    await shot(asha, `challenge-card-waiting-${name}`);

    // Ravi calls A, the right one: both picks, the answer and why. A right call is a spark, shown and not stored.
    await ravi.getByTestId(`challenge-option-${String(FINAL_CALL.answer)}`).click();
    await ravi.getByTestId('challenge-lock').click();
    await expect(ravi.getByTestId('challenge-status')).toHaveText(
      `You called ${letters[FINAL_CALL.answer]}. Asha fixture called B.`,
    );
    await expect(ravi.getByTestId('challenge-explain')).toHaveText(FINAL_CALL.explain);
    await expect(ravi.getByTestId('challenge-spark')).toHaveText('★ +1 spark');
    await expect(ravi.getByText('CALLED IT! · REVEALED')).toBeVisible();
    await shot(ravi, `challenge-card-revealed-${name}`);
    expect(await audit(ravi)).toEqual([]);
    expect(world.picks()).toEqual({ asha: 1, ravi: FINAL_CALL.answer });

    // Asha's card moves through the changes feed (a live hint, a focus or the slow poll asks for it; the page is brought back
    // to the foreground here): her wrong call is a plot twist, never a loss.
    await asha.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(asha.getByTestId('challenge-status')).toHaveText(
      `You called B. Ravi fixture called ${letters[FINAL_CALL.answer]}.`,
    );
    await expect(asha.getByTestId('challenge-twist')).toHaveText(FINAL_CALL.twist);
    await expect(asha.getByText('PLOT TWIST! · REVEALED')).toBeVisible();
    await expect(asha.getByTestId('challenge-spark')).toHaveCount(0);
    expect(await audit(asha)).toEqual([]);
    await ashaContext.close();
    await raviContext.close();
  });
}

test('recording paused: the challenge still goes, the sender’s own call is not saved, and the sheet says so', async ({
  page,
}) => {
  const world = challengeWorld();
  await openAsha(page, world, phone, { recordingPaused: true });
  const sheet = await openSheet(page);
  await sheet.getByRole('radio', { name: 'Ravi fixture' }).click();
  await sheet.getByTestId('challenge-pick-0').click();
  await sheet.getByRole('button', { name: 'Challenge Ravi fixture' }).click();
  await expect(sheet.getByText('Challenge sent to Ravi fixture')).toBeVisible();
  await expect(sheet.getByText('Recording is paused.')).toBeVisible();
  await expect(sheet.getByText(/your own call was not saved/)).toBeVisible();
  // Nothing was sent to keep the pick, and nothing is stored.
  expect(locks(world, 'asha')).toEqual([]);
  expect(world.picks()).toEqual({});
  expect(await audit(page)).toEqual([]);
});

test('the end of the Scroll offers Challenge a friend beside Small print, and it opens the same sheet', async ({
  page,
}) => {
  const world = challengeWorld();
  await openAsha(page, world, phone);
  await page.getByRole('button', { name: 'The end of this Scroll', exact: true }).click();
  await expect(page.getByTestId('end-tray')).toBeVisible();
  await page.getByTestId('end-tray').getByRole('button', { name: 'Challenge a friend' }).click();
  await expect(page.getByRole('dialog', { name: 'Challenge a friend' })).toBeVisible();
  await expect(page.getByTestId('challenge-sheet-prompt')).toHaveText(FINAL_CALL.prompt);
});
