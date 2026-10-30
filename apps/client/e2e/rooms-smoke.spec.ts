import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { roomFixture, type RoomCall } from './rooms-fixture';

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
