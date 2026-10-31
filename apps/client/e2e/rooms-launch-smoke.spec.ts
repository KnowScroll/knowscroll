import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { id } from './encounter-fixture';
import { roomFixture } from './rooms-fixture';
import { DECK, LaunchWorld, TIMING, launchRoutes, type Who } from './rooms-launch-fixture';
import { skyOf, skyWorld } from './rooms-sky-fixture';

/**
 * The Launch (v3 R-6) in the production export over labelled HTTP fixtures, for two people who share one room: Ravi starts it, Asha
 * joins from another browser, they answer five questions on the world's clock, and both see the podium and the room's star. The
 * fixture keeps the server's rules (the clock decides, a question only while it is open, its key only after it closes); the screen
 * counts the time each view carries. Axe covers names, roles and contrast at 390 and 1440. With `KS_ROOM_SHOTS` set to a folder,
 * each step also saves a screenshot there (never inside the repository).
 */
const shotsFolder = process.env['KS_ROOM_SHOTS'];
async function shoot(page: Page, name: string) {
  if (shotsFolder === undefined) return;
  mkdirSync(shotsFolder, { recursive: true });
  await page.screenshot({ path: join(shotsFolder, `${name}.png`) });
}

async function seriousViolations(page: Page, within?: string) {
  const builder = new AxeBuilder({ page });
  if (within !== undefined) builder.include(within);
  const results = await builder
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({
      rule: violation.id,
      targets: violation.nodes.slice(0, 4).map((node) => `${node.target.join(' ')}  ${node.html.slice(0, 100)}`),
    }));
}

const VIEWPORTS = [
  { name: 'phone', size: { width: 390, height: 844 } },
  { name: 'desktop', size: { width: 1440, height: 900 } },
] as const;
const scope = { accountId: id(1), privacyEpoch: 1 };

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

/** The room's sky as the server would say it: it follows the stars the world has earned. */
function followingSky(world: LaunchWorld) {
  const sky = skyWorld(0);
  Object.defineProperty(sky, 'stars', { get: () => world.stars, set: () => undefined });
  return sky;
}

/** One person's tab in the room, over the shared world. */
async function openRoom(
  page: Page,
  world: LaunchWorld,
  sky: ReturnType<typeof skyWorld>,
  who: Who,
  size: { width: number; height: number },
) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { address } = await roomFixture(page, size, {
    others: 1,
    lastMessageMinutesAgo: 5,
    noticeSeen: true,
    sky: () => skyOf(sky),
    launch: () => world.strip(),
  });
  await launchRoutes(page, world, who, scope);
  await page.goto(address);
}

/** D-140: on a phone the conversation keeps at least 60 percent of the screen when no Launch is running. */
async function expectConversationKeepsMostOfThePhone(page: Page) {
  const messages = await page.getByTestId('room-messages').boundingBox();
  expect(messages).not.toBeNull();
  const share = messages!.height / VIEWPORTS[0].size.height;
  // eslint-disable-next-line no-console -- the measurement is the evidence the slice reports
  console.log(
    `room at 390x844 with the Launch chip: messages ${String(Math.round(messages!.height))} px (${(share * 100).toFixed(1)} %)`,
  );
  expect(share).toBeGreaterThanOrEqual(0.6);
}

for (const { name, size } of VIEWPORTS) {
  test(`${name}: Ravi starts a Launch, Asha joins, both play five questions and see the podium and the star`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);
    const world = new LaunchWorld(5);
    await openRoom(page, world, followingSky(world), 'ravi', size);

    // Before anything starts: a chip that offers a quiz, no mark on the band, and the conversation keeps its room.
    await expect(page.getByTestId('now-strip')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Launch, Start a quiz' })).toBeVisible();
    await expect(page.getByTestId('band-live')).toHaveCount(0);
    await expect(page.getByTestId('launch-stage')).toHaveCount(0);
    await shoot(page, `${name}-1-chip`);
    expect(await seriousViolations(page)).toEqual([]);
    if (name === 'phone') await expectConversationKeepsMostOfThePhone(page);

    // Start: the sheet says what it is and who hosts it, and nothing starts without the tap.
    await page.getByTestId('now-launch').click();
    await expect(page.getByTestId('launch-start-sheet')).toContainText('Pixel');
    await expect(page.getByTestId('launch-start-sheet')).toContainText('AI · Quizmaster');
    await expect(page.getByTestId('launch-start')).toBeEnabled();
    // The sheet fades in; contrast is read on the finished frame, not on the way (a half-transparent label reads as low contrast).
    await expect(page.getByTestId('launch-start-sheet')).toHaveCSS('opacity', '1');
    await shoot(page, `${name}-2-start-sheet`);
    expect(await seriousViolations(page)).toEqual([]);
    await page.getByTestId('launch-start').click();

    // The lobby on the stage: the host, who is in, and the time left in words.
    await expect(page.getByTestId('launch-stage')).toBeVisible();
    await expect(page.getByTestId('launch-host-line')).toContainText('You’re in');
    await expect(page.getByTestId('launch-host-label')).toHaveText('AI · Quizmaster');
    await expect(page.getByTestId('band-live')).toBeVisible();
    await expect(page.getByLabel('In this Launch: Ravi, you')).toBeVisible();
    await shoot(page, `${name}-3-lobby`);
    expect(await seriousViolations(page)).toEqual([]);

    // Asha, in another browser, sees the Launch is on and joins.
    const other = await browser.newContext();
    const asha = await other.newPage();
    await openRoom(asha, world, followingSky(world), 'asha', size);
    await expect(asha.getByTestId('launch-stage')).toBeVisible({ timeout: 15_000 });
    await asha.getByTestId('launch-join').click();
    await expect(asha.getByTestId('launch-in')).toBeVisible();
    await shoot(asha, `${name}-3b-lobby-asha`);

    for (let round = 1; round <= 5; round++) {
      const question = DECK[round - 1]!;
      // The question is open: its words, the time as a number, and nothing that names the key.
      await expect(page.getByTestId('launch-prompt')).toHaveText(question.prompt, { timeout: 20_000 });
      await expect(page.getByTestId('launch-round')).toHaveText(`${String(round)} OF 5`);
      await expect(page.getByTestId('launch-timer')).toBeVisible();
      await expect(page.getByText('Right answer')).toHaveCount(0);
      await expect(page.getByTestId('launch-explain')).toHaveCount(0);
      if (name === 'phone' && round === 1) {
        // While a Launch runs the stage takes the top of the phone (R3 E 1); the share is recorded, not asserted.
        const messages = await page.getByTestId('room-messages').boundingBox();
        // eslint-disable-next-line no-console -- the measurement is the evidence the slice reports
        console.log(
          `room at 390x844 while a Launch runs: messages ${String(Math.round(messages?.height ?? 0))} px (${(((messages?.height ?? 0) / VIEWPORTS[0].size.height) * 100).toFixed(1)} %)`,
        );
      }
      if (round === 1 || round === 3) {
        await shoot(page, `${name}-4-question-${String(round)}`);
        expect(await seriousViolations(page)).toEqual([]);
      }
      // Ravi is always right; Asha is right on the first three and wrong after (and answers a beat later).
      const options = page.locator('[data-testid^="launch-option-"]');
      await expect(options).toHaveCount(question.options.length);
      await page.getByTestId(`launch-option-${String(question.answer)}`).click();
      await expect(page.getByTestId('launch-locked')).toBeVisible();
      await expect(page.getByTestId(`launch-option-${String(question.answer)}`)).toHaveAccessibleName(/Locked in$/);
      await expect(asha.getByTestId('launch-prompt')).toHaveText(question.prompt);
      await asha.waitForTimeout(400);
      const choice = round <= 3 ? question.answer : (question.answer + 1) % question.options.length;
      await asha.getByTestId(`launch-option-${String(choice)}`).click();
      await expect(asha.getByTestId('launch-locked')).toBeVisible();

      // The question closes: the right answer, the reason and who called it, in words.
      await expect(page.getByTestId('launch-reveal')).toBeVisible({ timeout: TIMING.answerMs + 8_000 });
      await expect(page.getByLabel(new RegExp(`, Right answer$`))).toBeVisible();
      await expect(page.getByTestId('launch-explain')).toHaveText(question.explain);
      await expect(page.getByTestId('launch-called')).toHaveText(round <= 3 ? '2 of 2 called it' : '1 of 2 called it');
      await expect(asha.getByTestId('launch-called')).toBeVisible();
      if (round === 3) {
        await shoot(page, `${name}-5-reveal-3`);
        await shoot(asha, `${name}-5b-reveal-3-asha`);
        expect(await seriousViolations(page)).toEqual([]);
      }
    }

    // The podium opens on both screens: the top two, the star the room earned and the share card of squares.
    await expect(page.getByTestId('launch-podium')).toBeVisible({ timeout: 20_000 });
    await expect(asha.getByTestId('launch-podium')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByLabel('First, Ravi, you, 5 of 5')).toBeVisible();
    await expect(page.getByLabel('Second, Asha, 3 of 5')).toBeVisible();
    await expect(page.getByTestId('podium-star')).toContainText('+1 star for the room');
    await expect(page.getByTestId('podium-star')).toContainText('1 more star lights the station');
    await expect(page.getByTestId('launch-share-card')).toContainText('Space room · Launch 26 Oct · 5/5');
    await expect(page.getByTestId('launch-share-card')).toContainText('■■■■■');
    await expect(asha.getByTestId('launch-share-card')).toContainText('Space room · Launch 26 Oct · 3/5');
    await expect(asha.getByTestId('launch-share-card')).toContainText('■■■□□');
    await expect(page.getByText(/week|month|all-time|leaderboard/i)).toHaveCount(0);
    await shoot(page, `${name}-6-podium`);
    await shoot(asha, `${name}-6b-podium-asha`);
    expect(await seriousViolations(page)).toEqual([]);

    // Sharing posts the squares and nothing else into General.
    await asha.getByTestId('launch-share').click();
    await expect(asha.getByText('Shared in General')).toBeVisible();
    expect(world.posts).toEqual([{ who: 'asha', text: 'Space room · Launch 26 Oct · 3/5\n■■■□□' }]);
    for (const question of DECK) expect(world.posts[0]!.text).not.toContain(question.prompt);

    // Back to the chat: the stage is gone, the room's strip says Podium, and the star is on the room's sky.
    await page.getByTestId('launch-close').click();
    await expect(page.getByTestId('launch-podium')).toHaveCount(0);
    await expect(page.getByTestId('launch-stage')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Launch, Podium' })).toBeVisible();
    // The settled Launch was told to the world once by each device that saw it end, and settled once.
    expect(world.stars).toBe(6);
    expect(world.calls.filter((call) => call.path.endsWith('/finish') && call.who === 'ravi')).toHaveLength(1);
    await shoot(page, `${name}-7-after`);
    expect(await seriousViolations(page)).toEqual([]);
    await other.close();
  });
}

test('phone: while recording is paused the Launch says so and an answer is not sent', async ({ page }) => {
  const world = new LaunchWorld(0);
  world.start('asha');
  const { address } = await roomFixture(page, VIEWPORTS[0].size, {
    others: 1,
    lastMessageMinutesAgo: 5,
    noticeSeen: true,
    recordingPaused: true,
    launch: () => world.strip(),
  });
  await launchRoutes(page, world, 'ravi', scope);
  await page.goto(address);
  await expect(page.getByTestId('launch-stage')).toBeVisible();
  await page.getByTestId('launch-join').click();
  await expect(page.getByTestId('launch-paused')).toContainText('Recording is paused.');
  await expect(page.getByTestId('launch-paused')).toContainText('can’t be played while recording is paused');
  expect(world.calls.filter((call) => call.path.endsWith('/join') || call.path.endsWith('/answer'))).toHaveLength(0);
  expect(await seriousViolations(page)).toEqual([]);
});
