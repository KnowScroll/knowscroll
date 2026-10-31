import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { id } from './encounter-fixture';
import { generalId, room, roomFixture, type RoomCall } from './rooms-fixture';

/**
 * The room as a place (v3 R-1) in the production export over labelled HTTP fixtures: General under the room's band, the
 * faces of who has the room open, the honest quiet pill, the AI notice once, the room menu with the member's own AI
 * settings, and D04's rail. Axe covers names, roles and contrast. With `KS_ROOM_SHOTS` set to a folder, each step also
 * saves a screenshot there (for the PR; never inside the repository).
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

const callsTo = (calls: readonly RoomCall[], path: string) => calls.filter((call) => call.path === path);
const phone = { width: 390, height: 844 };
const desktop = { width: 1440, height: 900 };

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

test('on a phone a member lands in General under the room’s band, sees the notice once, and says the room is open', async ({
  page,
}) => {
  const { calls, address } = await roomFixture(page, phone, {
    others: 1,
    lastMessageMinutesAgo: 180,
    noticeSeen: false,
  });
  await page.goto(address);
  await expect(page.getByTestId('campfire-header')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Space room, room menu' })).toBeVisible();
  // Two people here: named faces and no number. Nothing says "online".
  await expect(page.getByTestId('here-caption')).toHaveText('You and Asha are here');
  await expect(page.getByTestId('campfire-subline')).toHaveText(/Open to everyone/i);
  await expect(page.getByText(/online/i)).toHaveCount(0);
  await expect(page.getByTestId('quiet-pill')).toHaveText(/Quiet right now · last message 3 h ago/i);
  await expect(page.getByText('Huh. Then what is it?')).toBeVisible();
  await expect(page.getByTestId('ai-notice')).toBeVisible();
  await expect.poll(() => callsTo(calls, '/v1/rooms/presence').length).toBeGreaterThan(0);
  expect(callsTo(calls, '/v1/rooms/presence')[0]?.body).toMatchObject({ state: 'here' });
  await shoot(page, 'phone-1-first-visit');
  expect(await seriousViolations(page)).toEqual([]);

  await page.getByTestId('ai-notice-ack').click();
  await expect(page.getByTestId('ai-notice')).toHaveCount(0);
  expect(callsTo(calls, '/v1/rooms/preferences')[0]?.body).toMatchObject({ noticeSeen: true });
  await shoot(page, 'phone-2-campfire');
});

test('it says a number only from three people here', async ({ page }) => {
  const { address } = await roomFixture(page, phone, { others: 3, lastMessageMinutesAgo: 1, noticeSeen: true });
  await page.goto(address);
  await expect(page.getByTestId('campfire-subline')).toHaveText(/A room · 4 here/i);
  await expect(page.getByTestId('here-caption')).toHaveText('4 here');
  // Talking now: no quiet pill and no notice.
  await expect(page.getByTestId('quiet-pill')).toHaveCount(0);
  await expect(page.getByTestId('ai-notice')).toHaveCount(0);
  await shoot(page, 'phone-3-four-here');
});

test('the room menu holds About, Guidelines, AI here, Members, Pins and Topics, and saves the AI settings', async ({
  page,
}) => {
  const { calls, address } = await roomFixture(page, phone, { others: 1, lastMessageMinutesAgo: 2, noticeSeen: true });
  await page.goto(address);
  await page.getByRole('button', { name: 'Space room, room menu' }).click();
  const menu = page.getByRole('dialog');
  await expect(menu).toBeVisible();
  for (const label of ['About', 'Guidelines', 'AI here', 'Members', 'Pins', 'Topics'])
    await expect(menu.getByText(label, { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId('menu-members')).toContainText('24');
  await expect(page.getByTestId('menu-pins')).toContainText('1');
  await page.waitForTimeout(400);
  await shoot(page, 'phone-4-room-menu');
  expect(await seriousViolations(page, '[role="dialog"]')).toEqual([]);

  await page.getByTestId('menu-ai').click();
  await page.getByRole('radio', { name: 'Quieter' }).click();
  await expect.poll(() => callsTo(calls, '/v1/rooms/preferences').length).toBe(1);
  expect(callsTo(calls, '/v1/rooms/preferences')[0]?.body).toMatchObject({ aiLevel: 'quieter' });
  await expect(page.getByRole('radio', { name: 'Quieter' })).toBeChecked();
  await page.getByRole('switch', { name: 'Keep my messages out of what AI reads' }).click();
  await expect.poll(() => callsTo(calls, '/v1/rooms/preferences').length).toBe(2);
  expect(callsTo(calls, '/v1/rooms/preferences')[1]?.body).toMatchObject({ keepOut: true });
  await expect(page.getByRole('switch', { name: 'Keep my messages out of what AI reads' })).toBeChecked();
  await shoot(page, 'phone-5-ai-here');
  expect(await seriousViolations(page, '[role="dialog"]')).toEqual([]);

  await page.getByRole('button', { name: 'Back to the room menu' }).click();
  await page.getByTestId('menu-pins').click();
  await expect(page.getByText('Dark matter or modified gravity?')).toBeVisible();
});

test('on a desktop the rail has General first, the member’s AI settings and the total, and Here now is on the right', async ({
  page,
}) => {
  const { address } = await roomFixture(page, desktop, { others: 2, lastMessageMinutesAgo: 1, noticeSeen: true });
  await page.goto(address);
  await expect(page.getByTestId('room-workspace')).toBeVisible();
  await expect(page.getByTestId('general-row')).toHaveAttribute('aria-current', 'true');
  await expect(page.getByText('Huh. Then what is it?')).toBeVisible();
  await expect(page.getByTestId('rail-members')).toHaveText('Members · 24');
  await expect(page.getByTestId('rail-ai-here')).toBeVisible();
  await expect(page.getByTestId('here-now')).toContainText('Ravi (you)');
  await expect(page.getByTestId('here-now')).toContainText('Here now · 3');
  await expect(page.getByText(/online/i)).toHaveCount(0);
  await shoot(page, 'desktop-1-room');
  expect(await seriousViolations(page)).toEqual([]);
});

test('a resident that answered on its own is named, labelled as AI and says why, on a phone and on a desktop', async ({
  page,
}) => {
  await roomFixture(page, phone, { others: 1, lastMessageMinutesAgo: 8, noticeSeen: true, resident: 'lively' });
  await page.goto(`/rooms/${room.roomId}`);
  const header = page.getByTestId('resident-header');
  await expect(header).toContainText('Nova');
  await expect(header).toContainText('AI · Explainer');
  await expect(header).toContainText('Explanation');
  await expect(page.getByTestId('resident-why')).toHaveText('Answering a question nobody had answered yet');
  await expect(page.getByText(/Lensing maps show the missing mass/)).toBeVisible();
  await shoot(page, 'phone-6-resident-answer');
  expect(await seriousViolations(page)).toEqual([]);

  await roomFixture(page, desktop, { others: 2, lastMessageMinutesAgo: 8, noticeSeen: true, resident: 'lively' });
  await page.goto(`/rooms/${room.roomId}`);
  await expect(page.getByTestId('resident-header')).toContainText('Nova');
  await shoot(page, 'desktop-2-resident-answer');
  expect(await seriousViolations(page)).toEqual([]);
});

test('for a Quieter reader a resident’s own message is one line with the words one tap away', async ({ page }) => {
  await roomFixture(page, phone, { others: 1, lastMessageMinutesAgo: 8, noticeSeen: true, resident: 'quieter' });
  await page.goto(`/rooms/${room.roomId}`);
  await expect(page.getByTestId('resident-folded')).toContainText('Nova added something.');
  await expect(page.getByText(/Lensing maps show the missing mass/)).toHaveCount(0);
  await shoot(page, 'phone-7-resident-folded');
  expect(await seriousViolations(page)).toEqual([]);
  await page.getByTestId('resident-show').click();
  await expect(page.getByText(/Lensing maps show the missing mass/)).toBeVisible();
  await expect(page.getByTestId('resident-header')).toContainText('AI · Explainer');
});

test('for a reader whose AI is Off nothing a resident said on its own is drawn', async ({ page }) => {
  await roomFixture(page, phone, { others: 1, lastMessageMinutesAgo: 8, noticeSeen: true, resident: 'off' });
  await page.goto(`/rooms/${room.roomId}`);
  await expect(page.getByText('Huh. Then what is it?')).toBeVisible();
  await expect(page.getByTestId('resident-header')).toHaveCount(0);
  await expect(page.getByTestId('resident-folded')).toHaveCount(0);
  await shoot(page, 'phone-8-resident-off');
});

const messageIds = (n: number) => id(600 + n);
const topicIds = (n: number) => id(500 + n);

/** Opens a message's options the way a pointer does: the line first, then its ⋯. */
async function openOptions(page: Page, sequence: number) {
  await page.getByTestId(`message-${String(sequence)}`).hover();
  await page
    .getByTestId(`message-options-${String(sequence)}`)
    .getByRole('button', { name: 'Message options' })
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

test('from any message a member can ask a resident about it, challenge it, hear the other side, mark it useful and start a topic', async ({
  page,
}) => {
  const { calls, address } = await roomFixture(page, phone, {
    others: 1,
    lastMessageMinutesAgo: 2,
    noticeSeen: true,
    topics: true,
  });
  await page.goto(address);
  await expect(page.getByText('Huh. Then what is it?')).toBeVisible();

  await openOptions(page, 3);
  for (const testID of [
    'option-start-topic',
    'option-ask-about',
    'option-ask-other_side',
    'option-ask-challenge',
    'option-useful',
  ])
    await expect(page.getByTestId(testID)).toBeVisible();
  await expect(page.getByTestId('option-ask-about')).toContainText('Ask Nova about this');
  await expect(page.getByRole('dialog')).toContainText('Halley argues the opposite.');
  await page.waitForTimeout(400);
  await shoot(page, 'phone-9-message-options');
  expect(await seriousViolations(page, '[role="dialog"]')).toEqual([]);

  // Challenge: Halley tests that message; the ask names the message and the kind.
  await page.getByTestId('option-ask-challenge').click();
  await expect.poll(() => callsTo(calls, '/v1/rooms/inhabitants/ask').length).toBe(1);
  expect(callsTo(calls, '/v1/rooms/inhabitants/ask')[0]?.body).toMatchObject({
    about: { kind: 'challenge', messageId: messageIds(3) },
  });
  expect(callsTo(calls, '/v1/rooms/inhabitants/ask')[0]?.body).not.toHaveProperty('inhabitant');

  // Useful: one tap marks it, and the message says so to the person who marked it.
  await openOptions(page, 3);
  await page.getByTestId('option-useful').click();
  await expect.poll(() => callsTo(calls, '/v1/rooms/discussions/useful').length).toBe(1);
  expect(callsTo(calls, '/v1/rooms/discussions/useful')[0]?.body).toMatchObject({
    messageId: messageIds(3),
    useful: true,
  });
  await expect(page.getByTestId(`useful-${messageIds(3)}`)).toHaveText('You marked this useful');

  // A topic from the message: its first words are the title to edit, the tag is one of four.
  await openOptions(page, 3);
  await page.getByTestId('option-start-topic').click();
  await expect(page.getByTestId('start-topic-sheet')).toBeVisible();
  await expect(page.getByTestId('start-topic-title')).toHaveValue('Huh. Then what is it?');
  await page.getByTestId('start-topic-tag-question').click();
  await page.waitForTimeout(400);
  await shoot(page, 'phone-10-start-topic');
  expect(await seriousViolations(page, '[role="dialog"]')).toEqual([]);
  await page.getByTestId('start-topic-submit').click();
  await expect.poll(() => callsTo(calls, '/v1/rooms/discussions/create').length).toBe(1);
  expect(callsTo(calls, '/v1/rooms/discussions/create')[0]?.body).toMatchObject({
    start: {
      kind: 'message',
      discussionId: generalId,
      messageId: messageIds(3),
      title: 'Huh. Then what is it?',
      tag: 'question',
    },
  });
});

test('an answer to an ask says who asked and what, and a topic card opens the topic with its figures', async ({
  page,
}) => {
  await roomFixture(page, phone, { others: 1, lastMessageMinutesAgo: 8, noticeSeen: true, topics: true, asked: true });
  await page.goto(`/rooms/${room.roomId}`);
  await expect(page.getByTestId('resident-asked')).toHaveText('Asked by Asha · Challenge');
  await expect(page.getByTestId('resident-header').last()).toContainText('Halley');
  await expect(page.getByTestId('resident-header').last()).toContainText('AI · Skeptic');
  await expect(page.getByTestId(`challenge-${messageIds(5)}`)).toBeVisible();
  await expect(page.getByTestId(`other-side-${messageIds(5)}`)).toBeVisible();
  const card = page.getByTestId(`topic-card-${topicIds(3)}`);
  await expect(card).toContainText('Could we ever detect dark matter directly?');
  await expect(card).toContainText('Question');
  await expect(card).toContainText('7 replies · last: Kenji');
  await shoot(page, 'phone-11-asked-and-topic-card');
  expect(await seriousViolations(page)).toEqual([]);
  await card.click();
  await expect(page).toHaveURL(new RegExp(`/rooms/${room.roomId}/t/${topicIds(3)}`));
});

test('the topics list is a forum: tags, replies and who spoke last, sorted Hot, New or Unanswered, with Useful on topics only', async ({
  page,
}) => {
  const { calls, address } = await roomFixture(page, phone, {
    others: 1,
    lastMessageMinutesAgo: 2,
    noticeSeen: true,
    topics: true,
  });
  await page.goto(address);
  await page.getByRole('button', { name: 'Space room, room menu' }).click();
  await page.getByTestId('menu-topics').click();
  const menu = page.getByRole('dialog');
  await expect(menu.getByTestId(`discussion-${topicIds(2)}`)).toContainText('Pinned by the moderator');
  await expect(menu.getByTestId(`discussion-${topicIds(2)}`)).toContainText('8 replies · last: Halley');
  await expect(menu.getByTestId(`discussion-${topicIds(2)}`)).toContainText('9 useful');
  await expect(menu.getByTestId(`discussion-${topicIds(4)}`)).toContainText('No replies yet');
  await expect(menu.getByTestId('sort-hot')).toHaveAttribute('aria-checked', 'true');
  await page.waitForTimeout(400);
  await shoot(page, 'phone-12-topics');
  expect(await seriousViolations(page, '[role="dialog"]')).toEqual([]);

  await menu.getByTestId('sort-unanswered').click();
  await expect.poll(() => callsTo(calls, '/v1/rooms/topics/list').at(-1)?.body['sort']).toBe('unanswered');
  await expect(menu.getByTestId(`discussion-${topicIds(4)}`)).toBeVisible();
  await expect(menu.getByTestId(`discussion-${topicIds(3)}`)).toHaveCount(0);
  await menu.getByTestId('sort-new').click();
  await menu.getByTestId('tag-question').click();
  await expect
    .poll(() => callsTo(calls, '/v1/rooms/topics/list').at(-1)?.body)
    .toMatchObject({ sort: 'new', tag: 'question' });
  await expect(menu.getByTestId(`discussion-${topicIds(3)}`)).toBeVisible();
  await expect(menu.getByTestId(`discussion-${topicIds(2)}`)).toHaveCount(0);
  await expect(menu.getByTestId('new-topic')).toBeVisible();
});

test('the room menu shows the limits to everyone, and says asked turns have their own', async ({ page }) => {
  await roomFixture(page, phone, { others: 1, lastMessageMinutesAgo: 2, noticeSeen: true });
  await page.goto(`/rooms/${room.roomId}`);
  await page.getByRole('button', { name: 'Space room, room menu' }).click();
  await page.getByTestId('menu-ai').click();
  await expect(page.getByTestId('limits-asked')).toContainText('10 asks an hour each');
  await expect(page.getByTestId('limits-asked')).toContainText('80 a day for the room');
  await expect(page.getByTestId('limits-asked')).toContainText('never uses up what AI may say on its own');
  await expect(page.getByTestId('limits-unprompted')).toContainText('one turn for every 3 messages');
  await expect(page.getByTestId('limits-unprompted')).toContainText('8 an hour and 40 a day');
  await page.waitForTimeout(400);
  await shoot(page, 'phone-13-limits');
  expect(await seriousViolations(page, '[role="dialog"]')).toEqual([]);
});

test('a newcomer is welcomed by a resident from a template, with the notice, and it goes once the notice is read', async ({
  page,
}) => {
  const { calls, address } = await roomFixture(page, phone, {
    others: 1,
    lastMessageMinutesAgo: 2,
    noticeSeen: false,
    welcome: true,
  });
  await page.goto(address);
  const welcome = page.getByTestId('room-welcome');
  await expect(welcome).toContainText('Nova');
  await expect(welcome).toContainText('AI · Explainer');
  await expect(welcome).toContainText('Welcome to Space room.');
  await shoot(page, 'phone-14-welcome');
  expect(await seriousViolations(page)).toEqual([]);
  await page.getByTestId('ai-notice-ack').click();
  await expect(page.getByTestId('room-welcome')).toHaveCount(0);
  expect(callsTo(calls, '/v1/rooms/preferences')[0]?.body).toMatchObject({ noticeSeen: true });
});

test('a member who came back after a long while is caught up by a resident, once, and the card goes when read', async ({
  page,
}) => {
  const { calls, address } = await roomFixture(page, phone, {
    others: 1,
    lastMessageMinutesAgo: 2,
    noticeSeen: true,
    away: 'ready',
  });
  await page.goto(address);
  const card = page.getByTestId('away-card');
  await expect(card).toContainText('Halley');
  await expect(card).toContainText('AI · Skeptic');
  await expect(card).toContainText('While you were away, since');
  await expect(page.getByTestId('away-text')).toContainText('Two people compared dark matter with modified gravity.');
  await shoot(page, 'phone-15-while-you-were-away');
  expect(await seriousViolations(page)).toEqual([]);
  await page.getByTestId('away-dismiss').click();
  await expect(page.getByTestId('away-card')).toHaveCount(0);
  expect(callsTo(calls, '/v1/rooms/away/dismiss')).toHaveLength(1);
});

test('while the resident is still writing the card says so, and for a Quieter member it is one line', async ({
  page,
}) => {
  await roomFixture(page, phone, { others: 1, lastMessageMinutesAgo: 2, noticeSeen: true, away: 'preparing' });
  await page.goto(`/rooms/${room.roomId}`);
  await expect(page.getByTestId('away-preparing')).toContainText('Halley is catching you up');
  await shoot(page, 'phone-16-away-preparing');
  expect(await seriousViolations(page)).toEqual([]);

  await roomFixture(page, phone, { others: 1, lastMessageMinutesAgo: 2, noticeSeen: true, away: 'folded' });
  await page.goto(`/rooms/${room.roomId}`);
  await expect(page.getByTestId('away-card')).toContainText('Halley caught you up.');
  await expect(page.getByTestId('away-text')).toHaveCount(0);
  await page.getByTestId('away-show').click();
  await expect(page.getByTestId('away-text')).toBeVisible();
});

test('on a desktop the topics list sits in the rail, the card and the asked answer are in General, and the away card leads', async ({
  page,
}) => {
  await roomFixture(page, desktop, {
    others: 2,
    lastMessageMinutesAgo: 8,
    noticeSeen: true,
    topics: true,
    asked: true,
    away: 'ready',
  });
  await page.goto(`/rooms/${room.roomId}`);
  await expect(page.getByTestId('room-workspace')).toBeVisible();
  await expect(page.getByTestId(`topic-card-${topicIds(3)}`).first()).toBeVisible();
  await expect(page.getByTestId('resident-asked')).toHaveText('Asked by Asha · Challenge');
  await expect(page.getByTestId('sort-hot')).toBeVisible();
  await expect(page.getByTestId(`discussion-${topicIds(2)}`)).toContainText('9 useful');
  await shoot(page, 'desktop-3-asks-topics-away');
  expect(await seriousViolations(page)).toEqual([]);
});
