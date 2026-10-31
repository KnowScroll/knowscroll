import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { id } from './encounter-fixture';
import { DECK } from './rooms-launch-fixture';
import { room, roomFixture } from './rooms-fixture';
import { QuietWorld, quietRoutes, type Who } from './rooms-quiet-fixture';

/**
 * The quiet room (v3 R-7) in the production export over labelled HTTP fixtures, for two people who share one room. Ravi is alone in a
 * room nobody has written in for three hours: the room says so, offers a warm-up from the host (labelled AI) and a replay of the Launch
 * Kenji and Asha played. He plays it against their recorded answers, leaves a question and asks a resident to answer it now. Lena,
 * in another browser, finds the question waiting and answers it; when Ravi comes back the room tells him a person answered. The
 * fixture keeps the server's rules: the questions go out without a key, the key comes with each answer, nothing about the person
 * replaying is stored, a resident's answer leaves the question open. Axe covers names, roles and contrast at 390 and 1440. With
 * `KS_ROOM_SHOTS` set to a folder, each step also saves a screenshot there (never inside the repository).
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

/** One person's tab in the quiet room, over the shared world. */
async function openRoom(page: Page, world: QuietWorld, who: Who, size: { width: number; height: number }) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { address } = await roomFixture(page, size, {
    others: 0,
    lastMessageMinutesAgo: 180,
    noticeSeen: true,
    replay: () => world.strip(),
    questions: () => world.questionsFor(who),
  });
  await quietRoutes(page, world, who, scope);
  await page.goto(address);
  return address;
}

for (const { name, size } of VIEWPORTS) {
  test(`${name}: alone in a quiet room, Ravi replays a Launch and leaves a question, and Lena's answer tells him`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(150_000);
    const world = new QuietWorld();
    const address = await openRoom(page, world, 'ravi', size);

    // The room says it is quiet, and offers things that really happened: a Launch to replay, from the host, labelled AI.
    await expect(page.locator('body')).toContainText(/Quiet right now · last message 3 h ago/i);
    await expect(page.getByTestId('now-replay')).toContainText('Launch of 31 Oct');
    await expect(page.getByTestId('now-questions')).toContainText('Leave a question');
    await expect(page.getByTestId('quiet-offer')).toBeVisible();
    await expect(page.getByTestId('quiet-offer-label')).toHaveText('AI · Quizmaster');
    await expect(page.getByTestId('quiet-offer-line')).toContainText('can be played again');
    await expect(page.getByTestId('quiet-offer').getByText(/online|here now|active now/i)).toHaveCount(0);
    await shoot(page, `${name}-1-quiet`);
    expect(await seriousViolations(page)).toEqual([]);

    // The replay: it says it is a replay on every screen, and starts only on a tap.
    await page.getByTestId('quiet-offer-replay').click();
    await expect(page.getByTestId('replay-sheet')).toHaveCSS('opacity', '1');
    await expect(page.getByTestId('replay-banner')).toContainText(
      'Replay. These answers were given on 31 Oct by the 2 people who played',
    );
    await expect(page.getByTestId('replay-banner')).toContainText('nothing is saved');
    await expect(page.getByTestId('replay-host-label')).toHaveText('AI · Quizmaster');
    await expect(page.getByTestId('replay-question')).toHaveCount(0);
    await shoot(page, `${name}-2-replay-start`);
    expect(await seriousViolations(page)).toEqual([]);
    await page.getByTestId('replay-start').click();

    for (let round = 1; round <= 5; round++) {
      const question = DECK[round - 1]!;
      await expect(page.getByTestId('replay-prompt')).toHaveText(question.prompt);
      await expect(page.getByTestId('replay-round')).toHaveText(`REPLAY ${String(round)} OF 5`);
      // Nothing names the key while the question is open.
      await expect(page.getByText('Right answer')).toHaveCount(0);
      await expect(page.getByTestId('replay-explain')).toHaveCount(0);
      // The seconds are real, so the open question is looked at in round two, with axe on the question alone: a round-one pause of
      // several seconds would let its eight run out.
      if (round === 2) {
        await shoot(page, `${name}-3-replay-question`);
        expect(await seriousViolations(page, '[data-testid="replay-question"]')).toEqual([]);
      }
      // Right on the first three, wrong after.
      const choice = round <= 3 ? question.answer : (question.answer + 1) % question.options.length;
      await page.getByTestId(`launch-option-${String(choice)}`).click();
      await expect(page.getByTestId('replay-reveal')).toBeVisible();
      await expect(page.getByTestId('replay-explain')).toHaveText(question.explain);
      await expect(page.getByTestId('replay-called')).toHaveText(round <= 3 ? '2 of 2 called it' : '1 of 2 called it');
      await expect(page.getByTestId('replay-verdict')).toContainText(round <= 3 ? 'Called it!' : 'Plot twist');
      if (round <= 3) await expect(page.getByTestId('replay-place')).toContainText('fastest');
      else await expect(page.getByTestId('replay-place')).toHaveCount(0);
      // Nobody is named as wrong, and the replay shows no podium and no star.
      await expect(page.getByTestId('replay-question').getByText(/wrong|podium|star/i)).toHaveCount(0);
      if (round === 1) {
        await shoot(page, `${name}-4-replay-reveal`);
        expect(await seriousViolations(page)).toEqual([]);
      }
      await page.getByTestId('replay-next').click();
    }
    await expect(page.getByTestId('replay-done')).toContainText('You’d have got 3 of 5 · ■■■□□');
    await expect(page.getByTestId('replay-done')).toContainText('The podium and the room’s star stay as they were.');
    await shoot(page, `${name}-5-replay-done`);
    expect(await seriousViolations(page)).toEqual([]);
    await page.getByTestId('replay-done-button').click();
    await expect(page.getByTestId('replay-sheet')).toHaveCount(0);

    // A replay stores nothing: it asked to read the Launch and to see five answers, and never touched a Launch command.
    const asked = world.calls.map((call) => call.path.replace('/v1/rooms/', ''));
    expect(asked.filter((path) => path === 'replay/read').length).toBeGreaterThanOrEqual(1);
    expect(asked.filter((path) => path === 'replay/round')).toHaveLength(5);
    expect(asked.filter((path) => path.startsWith('launch/'))).toEqual([]);
    for (const call of world.calls.filter((entry) => entry.path.endsWith('/round')))
      expect(Object.keys(call.body)).not.toContain('recordingGeneration');

    // Leave a question: the shelf says honestly that none waits, the sheet asks nothing without the tap.
    await page.getByTestId('now-questions').click();
    await expect(page.getByTestId('questions-sheet')).toHaveCSS('opacity', '1');
    await expect(page.getByTestId('questions-count')).toHaveText('NO QUESTION IS WAITING');
    await shoot(page, `${name}-6-shelf-empty`);
    expect(await seriousViolations(page)).toEqual([]);
    await page.getByTestId('question-compose').click();
    await expect(page.getByTestId('question-submit')).toBeDisabled();
    await page.getByTestId('question-text').fill('How do astronomers know how far away a star is?');
    await expect(page.getByRole('switch', { name: 'Ask Nova to answer now' })).toBeChecked();
    await expect(page.getByRole('switch', { name: 'Tell me when a person answers' })).toBeChecked();
    await shoot(page, `${name}-7-leave-question`);
    expect(await seriousViolations(page)).toEqual([]);
    await page.getByTestId('question-submit').click();
    await expect(page.getByTestId('question-left')).toContainText(
      'A resident is writing an answer now; it will say it is AI.',
    );
    await expect(page.getByTestId('question-left')).toContainText('open for people');
    await shoot(page, `${name}-8-question-left`);
    expect(await seriousViolations(page)).toEqual([]);
    const left = world.calls.find((call) => call.path.endsWith('/questions/leave'))!;
    expect(left.body).toMatchObject({
      text: 'How do astronomers know how far away a star is?',
      askNow: true,
      notify: true,
    });
    await page.getByRole('button', { name: 'Back to the room' }).click();

    // Lena, in another browser, finds the question waiting, and answers it as a person.
    const other = await browser.newContext();
    const lena = await other.newPage();
    await openRoom(lena, world, 'lena', size);
    await expect(lena.getByTestId('now-questions')).toContainText('1 question waiting');
    await lena.getByTestId('now-questions').click();
    await expect(lena.getByTestId('questions-count')).toHaveText('1 QUESTION WAITING');
    await expect(lena.getByText('Asked by Ravi')).toBeVisible();
    await shoot(lena, `${name}-9-shelf-lena`);
    await lena.getByRole('link', { name: /How do astronomers know how far away a star is\?, open for people/ }).click();
    await expect(lena).toHaveURL(new RegExp(`/rooms/${room.roomId}/t/${id(951)}`));
    // The resident's answer is there, labelled AI; a person's is still to come.
    await expect(lena.getByTestId('room-messages').getByText('AI · Explainer')).toBeVisible();
    await lena
      .getByLabel('Message Space room')
      .or(lena.getByRole('textbox').first())
      .fill('Parallax again, but from space: the Gaia satellite measured it for over a billion stars.');
    // The room stays mounted under the discussion, so two composers exist; the one with words is the one to send.
    await lena.locator('[data-testid="send-message"]:not([disabled])').click();
    await expect(lena.getByText(/Gaia satellite/)).toBeVisible();

    // Ravi comes back: the room tells him a person answered, who and how long it took, and it goes once he has seen it.
    await page.goto(address);
    await expect(page.getByTestId('question-reply-line')).toHaveText('Lena answered your question · 2 days later');
    await expect(page.getByTestId('now-questions')).toContainText('Leave a question');
    await shoot(page, `${name}-10-answered`);
    expect(await seriousViolations(page)).toEqual([]);
    await page.getByTestId('question-reply-dismiss').click();
    await expect(page.getByTestId('question-reply-line')).toHaveCount(0);
    expect(world.question?.noticed).toBe(true);
    await page.reload();
    await expect(page.getByTestId('now-replay')).toBeVisible();
    await expect(page.getByTestId('question-reply-line')).toHaveCount(0);
    await other.close();
  });
}
