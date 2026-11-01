import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { id } from './encounter-fixture';
import { feedRoutes, feedStrip, feedWorld, scoutFindId, type FeedWorld, type ScoutWorld } from './rooms-feed-fixture';
import { roomFixture } from './rooms-fixture';

/**
 * Scouts (v3 R-9) in the production export over labelled HTTP fixtures. A member sends a scout into a room and chooses, from the
 * room's own topics, where it looks; its find reads "Sent by Asha", is always labelled AI and links a real Scroll; a moderator may
 * stop it; and no screen says it watched or read anything. Axe covers names, roles and contrast at 390 and 1440. With
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
const noScout: ScoutWorld = { state: 'none', interests: [], cadence: 'daily', paused: false, stopped: false };

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

async function openFeed(page: Page, size: { width: number; height: number }, world: FeedWorld) {
  const { address } = await roomFixture(page, size, {
    others: 1,
    lastMessageMinutesAgo: 5,
    noticeSeen: true,
    feed: () => feedStrip(world),
  });
  const { calls } = await feedRoutes(page, world, scope);
  await page.goto(address);
  // The Now strip's Feed chip is on the phone and on the desktop workspace alike.
  await page.getByTestId('now-feed').click();
  await expect(page.getByTestId('feed-screen')).toBeVisible();
  return { calls };
}

for (const { name, size } of VIEWPORTS) {
  test(`${name}: a member sends a scout from the room's own topics, changes it, pauses it and takes it back`, async ({
    page,
  }) => {
    const world = feedWorld({ scout: { ...noScout } });
    const { calls } = await openFeed(page, size, world);
    await shoot(page, `${name}-scout-feed-button`);

    await page.getByTestId('feed-scout-open').click();
    const sheet = page.getByTestId('scout-sheet');
    await expect(sheet).toBeVisible();
    // The sheet says what it can read, who it signs as and who is responsible; nothing is ticked and nothing can be sent yet.
    await expect(sheet).toContainText('It always signs with your name');
    await expect(sheet).toContainText(
      'Never your messages, your threads, your private rooms, or anything you watched or read',
    );
    await expect(sheet).toContainText('Once a day per room is the most a scout can post');
    await expect(sheet).toContainText('You’re responsible for what it posts');
    await expect(sheet.getByRole('checkbox')).toHaveCount(4);
    await expect(sheet.getByRole('checkbox', { checked: true })).toHaveCount(0);
    await expect(page.getByTestId('scout-save')).toBeDisabled();
    await expect(sheet.getByText(/while you.re away/i)).toHaveCount(0);
    await page.waitForTimeout(300);
    await shoot(page, `${name}-scout-sheet`);
    expect(await seriousViolations(page)).toEqual([]);

    // The member's own choice: two of the room's topics, once a week. Nothing is sent until they press Send.
    await sheet.getByRole('checkbox', { name: 'Dark matter' }).click();
    await sheet.getByRole('checkbox', { name: 'Pulsars' }).click();
    await page.getByTestId('scout-cadence-weekly').click();
    await expect(page.getByTestId('scout-save')).toBeEnabled();
    expect(calls.filter((call) => call.path === '/v1/rooms/scout/set')).toHaveLength(0);
    await page.getByTestId('scout-save').click();
    await expect.poll(() => calls.filter((call) => call.path === '/v1/rooms/scout/set').length).toBe(1);
    expect(calls.find((call) => call.path === '/v1/rooms/scout/set')?.body).toMatchObject({
      scout: { interests: ['astro.dark-matter', 'astro.pulsars'], cadence: 'weekly', paused: false },
    });
    await expect(page.getByTestId('feed-scout-open')).toContainText('Your scout');

    // Reopened, it stands as sent, with a pause and a way to take it back.
    await page.getByTestId('scout-close').click();
    await expect(page.getByTestId('scout-sheet')).toHaveCount(0);
    await page.getByTestId('feed-scout-open').click();
    await expect(sheet.getByRole('checkbox', { name: 'Dark matter', checked: true })).toBeVisible();
    await expect(page.getByTestId('scout-status')).toContainText('Looking. It has not posted here yet.');
    await sheet.getByRole('switch', { name: 'Pause my scout' }).click();
    await page.getByTestId('scout-save').click();
    await expect.poll(() => world.scout?.paused).toBe(true);
    await page.waitForTimeout(300);
    await shoot(page, `${name}-scout-sheet-sent`);
    expect(await seriousViolations(page)).toEqual([]);

    await page.getByTestId('scout-remove').click();
    await expect.poll(() => world.scout?.state).toBe('none');
    await expect(page.getByTestId('scout-sheet')).toHaveCount(0);
    expect(calls.filter((call) => call.path === '/v1/rooms/scout/set').at(-1)?.body).toMatchObject({ scout: null });
  });

  test(`${name}: a scout's find is signed by its owner, labelled AI, links a real Scroll and has nothing to vote with`, async ({
    page,
  }) => {
    const world = feedWorld({ scout: { ...noScout }, scoutPost: true });
    await openFeed(page, size, world);
    const find = page.getByTestId(`feed-post-${scoutFindId}`);
    await expect(find).toContainText('Asha’s scout');
    await expect(find).toContainText('AI · Scout');
    await expect(find.getByTestId('feed-post-signature')).toHaveText('Sent by Asha');
    await expect(find).toContainText('A short walk through the two ways to weigh a galaxy');
    await expect(find).toContainText('How astronomers weigh a galaxy');
    await expect(find.getByRole('link', { name: 'Open Scroll' })).toBeVisible();
    // The label is read as words, the mark is for the eye, and the find never says its owner watched or read it.
    await expect(find.getByLabel('AI, Scout')).toBeVisible();
    await expect(find.getByText(/while .* away|watched|vote|\bonline\b/i)).toHaveCount(0);
    // Not a moderator: no way to stop it.
    await expect(find.getByTestId('feed-post-stop-scout')).toHaveCount(0);
    await shoot(page, `${name}-scout-find`);
    expect(await seriousViolations(page)).toEqual([]);
  });
}

test('phone: a moderator may stop a scout from its find', async ({ page }) => {
  const world = feedWorld({ scout: { ...noScout }, scoutPost: true, canEditMemory: true });
  const { calls } = await openFeed(page, VIEWPORTS[0].size, world);
  await page.getByTestId('feed-post-stop-scout').click();
  await expect
    .poll(() => calls.find((call) => call.path === '/v1/rooms/moderate')?.body)
    .toMatchObject({ action: { kind: 'stop_scout', personId: id(540) } });
  await shoot(page, 'phone-scout-find-moderator');
  expect(await seriousViolations(page)).toEqual([]);
});

test('phone: a Quieter reader’s scout find is held back and says whose scout found it', async ({ page }) => {
  await openFeed(page, VIEWPORTS[0].size, feedWorld({ scout: { ...noScout }, scoutPost: true, aiLevel: 'quieter' }));
  const find = page.getByTestId(`feed-post-${scoutFindId}`);
  await expect(find).toContainText('Asha’s scout found something. The note is in the talk.');
  await expect(find).not.toContainText('A short walk through');
  await expect(find.getByTestId('feed-post-signature')).toHaveText('Sent by Asha');
});

test('phone: while scouts are off in this world, the feed has no way to send one', async ({ page }) => {
  await openFeed(page, VIEWPORTS[0].size, feedWorld());
  await expect(page.getByTestId('feed-scout-open')).toHaveCount(0);
});

test('phone: a stopped scout tells its owner so', async ({ page }) => {
  await openFeed(
    page,
    VIEWPORTS[0].size,
    feedWorld({
      scout: { state: 'on', interests: ['astro.galaxies'], cadence: 'daily', paused: false, stopped: true },
    }),
  );
  await page.getByTestId('feed-scout-open').click();
  await expect(page.getByTestId('scout-status')).toContainText('A moderator stopped your scout in this room');
  await page.waitForTimeout(300);
  await shoot(page, 'phone-scout-stopped');
  expect(await seriousViolations(page)).toEqual([]);
});
