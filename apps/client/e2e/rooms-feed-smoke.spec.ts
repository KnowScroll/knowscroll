import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { id } from './encounter-fixture';
import { feedRoutes, feedStrip, feedWorld, findId, type FeedWorld } from './rooms-feed-fixture';
import { roomFixture } from './rooms-fixture';

/**
 * The residents' feed (v3 R-8) in the production export over labelled HTTP fixtures. A member sees what residents found in the
 * library on the Now strip and in the Feed: each find a real Reel or Scroll, a short note from a resident that is always labelled AI,
 * with no vote and no count of people; a moderator may replace what the residents remember; a Quieter reader's notes are held back,
 * an Off reader is listed none, and a room whose library has nothing new says so. Axe covers names, roles and contrast at 390 and
 * 1440. With `KS_ROOM_SHOTS` set to a folder, each step also saves a screenshot there (never inside the repository).
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

async function open(page: Page, size: { width: number; height: number }, world: FeedWorld) {
  const { address } = await roomFixture(page, size, {
    others: 1,
    lastMessageMinutesAgo: 5,
    noticeSeen: true,
    feed: () => feedStrip(world),
  });
  const { calls } = await feedRoutes(page, world, scope);
  await page.goto(address);
  return { calls };
}

for (const { name, size } of VIEWPORTS) {
  test(`${name}: the Now strip says who found something, the Feed lists the finds, and a resident's profile shows what they remember`, async ({
    page,
  }) => {
    const world = feedWorld({ canEditMemory: true });
    const { calls } = await open(page, size, world);

    // The Now strip: the Feed beside the sky, with who found something and how long ago. No number of people.
    await expect(page.getByTestId('now-feed')).toContainText('Nova found something · 2 h ago');
    await expect(page.getByTestId('now-strip').getByText(/online/i)).toHaveCount(0);
    await shoot(page, `${name}-room-now-strip`);
    expect(await seriousViolations(page)).toEqual([]);

    await page.getByTestId('now-feed').click();
    await expect(page).toHaveURL(/\/feed$/);
    await expect(page.getByTestId('feed-screen')).toBeVisible();
    // Each find: a labelled resident, a note, a real asset to open, and the way into the talk. Nothing to vote with.
    const first = page.getByTestId(`feed-post-${findId}`);
    await expect(first).toContainText('Nova');
    await expect(first).toContainText('AI · Explainer');
    await expect(first).toContainText('Worth a look: a short walk through how a cluster');
    await expect(first).toContainText('Light that bends around something we can’t see');
    await expect(first.getByRole('link', { name: 'Open Reel' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Start the talk|2 replies/ }).first()).toBeVisible();
    // The desktop room workspace has its own panes beside the feed; the feed itself has no vote and no count of people.
    const feedScreen = page.getByTestId('feed-screen');
    await expect(feedScreen.getByText(/vote|upvote|\blike\b|follow/i)).toHaveCount(0);
    await expect(feedScreen.getByText(/\bonline\b|here now/i)).toHaveCount(0);
    // The resident's mark is for the eye; the label says what it is, in the words a screen reader reads.
    await expect(first.getByLabel('AI, Explainer')).toBeVisible();
    await expect(page.getByTestId('feed-residents').getByRole('button')).toHaveCount(2);
    await shoot(page, `${name}-feed`);
    expect(await seriousViolations(page)).toEqual([]);

    // A resident's profile: what the residents remember, the rhythm they post by, and a moderator's editor.
    await page.getByTestId('feed-resident-explainer').click();
    await expect(page.getByTestId('resident-sheet')).toBeVisible();
    await expect(page.getByTestId('resident-memory-text')).toContainText('Nothing yet.');
    await expect(page.getByTestId('resident-rhythm')).toContainText('Looks at the room about 3 times a day');
    await expect(page.getByTestId('resident-rhythm')).toContainText('Each posts at most once every 6 hours');
    await expect(page.getByTestId('resident-rhythm')).toContainText('Residents cannot vote, message you');
    // The sheet fades in over 140 ms: look at it, and check it, once it has settled.
    await page.waitForTimeout(300);
    await shoot(page, `${name}-resident-profile`);
    expect(await seriousViolations(page)).toEqual([]);

    // A moderator replaces what the residents remember; the sheet then says a moderator wrote it.
    await page.getByTestId('memory-input').fill('This room is for beginners. Please be patient with questions.');
    await page.getByTestId('memory-save').click();
    await expect(page.getByTestId('resident-memory')).toContainText('A moderator wrote this.');
    await expect(page.getByTestId('resident-memory-text')).toContainText('This room is for beginners.');
    expect(calls.filter((call) => call.path === '/v1/rooms/memory/replace')).toHaveLength(1);
    expect(calls.find((call) => call.path === '/v1/rooms/memory/replace')?.body).toMatchObject({
      text: 'This room is for beginners. Please be patient with questions.',
    });
    await shoot(page, `${name}-memory-replaced`);
    expect(await seriousViolations(page)).toEqual([]);
    // Clearing hands it back to the residents.
    await page.getByTestId('memory-clear').click();
    await expect(page.getByTestId('resident-memory-text')).toContainText('Nothing yet.');
    expect(calls.filter((call) => call.path === '/v1/rooms/memory/replace').at(-1)?.body).toMatchObject({ text: null });
  });
}

test('phone: a Quieter reader’s notes are held back and say where to read them', async ({ page }) => {
  await open(page, VIEWPORTS[0].size, feedWorld({ aiLevel: 'quieter' }));
  await page.getByTestId('now-feed').click();
  const first = page.getByTestId(`feed-post-${findId}`);
  await expect(first).toContainText('Nova found something. The note is in the talk.');
  await expect(first).not.toContainText('Worth a look');
  await expect(first.getByLabel('AI, Explainer')).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
});

test('phone: for a reader whose AI is Off the strip says nothing, the feed lists nothing and says why', async ({
  page,
}) => {
  await open(page, VIEWPORTS[0].size, feedWorld({ aiLevel: 'off' }));
  await expect(page.getByTestId('now-strip')).toBeVisible();
  await expect(page.getByTestId('now-feed')).toHaveCount(0);
  // The room menu still has the way to the feed, where the reason is told.
  await page.getByTestId('room-menu-open').click();
  await page.getByTestId('menu-feed').click();
  await expect(page).toHaveURL(/\/feed$/);
  await expect(page.getByTestId('feed-empty')).toContainText('Residents are off for you');
  await expect(page.getByTestId('feed-list')).toHaveCount(0);
  await shoot(page, 'phone-feed-off');
  expect(await seriousViolations(page)).toEqual([]);
});

test('phone: a room whose library has nothing new says so, and invents nothing', async ({ page }) => {
  await open(page, VIEWPORTS[0].size, feedWorld({ posts: false }));
  await expect(page.getByTestId('now-feed')).toHaveCount(0);
  await page.getByTestId('room-menu-open').click();
  await page.getByTestId('menu-feed').click();
  await expect(page.getByTestId('feed-empty')).toContainText('Nothing new right now');
  await expect(page.getByTestId('feed-empty')).toContainText('They say nothing when it has not.');
  await shoot(page, 'phone-feed-empty');
  expect(await seriousViolations(page)).toEqual([]);
});

test('phone: a member who is not a moderator sees what the residents remember and no editor', async ({ page }) => {
  await open(
    page,
    VIEWPORTS[0].size,
    feedWorld({ memory: { state: 'ready', text: 'People compared lensing with modified gravity.', by: 'residents' } }),
  );
  await page.getByTestId('now-feed').click();
  await page.getByTestId('feed-resident-skeptic').click();
  await expect(page.getByTestId('resident-memory-text')).toContainText('People compared lensing');
  await expect(page.getByTestId('resident-memory')).toContainText('It never has a name');
  await expect(page.getByTestId('memory-editor')).toHaveCount(0);
});
