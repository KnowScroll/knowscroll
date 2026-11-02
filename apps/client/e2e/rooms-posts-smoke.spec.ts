import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { id } from './encounter-fixture';
import {
  deviPostId,
  feedRoutes,
  liveStrip,
  feedWorld,
  findId,
  sourcePostId,
  type FeedWorld,
} from './rooms-feed-fixture';
import { roomFixture } from './rooms-fixture';

/**
 * People's posts and votes in the Feed (v3 R-8b, T3 "Rooms with residents") in the production export over labelled HTTP fixtures.
 * Members' posts and residents' finds sit side by side; Hot, New and Top change the order; a vote is a number and one tap, and a
 * resident has none to give; a member posts a find with a source and sees it; a source is a plain link to the address. Axe covers
 * names, roles and contrast at 390 and 1440. With `KS_ROOM_SHOTS` set to a folder, each step also saves a screenshot there (never
 * inside the repository).
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

/** The person's own Keep list: one Reel they may bring into a room (a labelled fixture). */
async function keepOneReel(page: Page) {
  await page.route('**/v1/saved*', (route) =>
    route.fulfill({
      json: {
        pagination: 'saved-page.v1',
        consistency: 'live',
        filter: new URL(route.request().url()).searchParams.get('filter'),
        limit: 20,
        scope,
        continuation: { status: 'end' },
        revision: 1,
        items: [
          {
            assetId: id(532),
            assetRevision: 1,
            savedAt: '2026-10-20T10:00:00.000Z',
            savedEntryId: id(992),
            kind: 'reel',
            availability: 'available',
            metadata: {
              kind: 'reel',
              title: 'Light that bends around something we can’t see',
              summary: 'A galaxy cluster bends the light of galaxies far behind it.',
              language: 'en',
            },
          },
        ],
      },
    }),
  );
}

async function openFeed(page: Page, size: { width: number; height: number }, world: FeedWorld) {
  const { address } = await roomFixture(page, size, {
    others: 1,
    lastMessageMinutesAgo: 5,
    noticeSeen: true,
    live: () => liveStrip(world),
  });
  const { calls } = await feedRoutes(page, world, scope);
  await keepOneReel(page);
  await page.goto(address);
  // The Feed chip is on the Now strip at every width, whatever the strip says of what happened lately.
  await page.getByTestId('now-feed-open').click();
  await expect(page.getByTestId('room-tab-feed')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('feed-screen')).toBeVisible();
  return { calls };
}

const order = async (page: Page) =>
  page
    .getByTestId('feed-list')
    .locator('[data-testid^="feed-post-"][role="article"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')?.replace('feed-post-', '') ?? ''));

for (const { name, size } of VIEWPORTS) {
  test(`${name}: people's posts and residents' finds are in one Feed, with a vote that counts people and a source that is a plain link`, async ({
    page,
  }) => {
    const world = feedWorld({ memberPosts: true });
    const { calls } = await openFeed(page, size, world);

    // Mixed: the member's Reel, the member's source, and the residents' finds, each by its author.
    const reel = page.getByTestId(`feed-post-${deviPostId}`);
    await expect(reel).toContainText('Devi');
    await expect(reel).toContainText('Found a Reel on gravitational lensing');
    await expect(reel).toContainText('Light that bends around something we can’t see');
    await expect(reel.getByLabel(/^AI,/)).toHaveCount(0);
    const nova = page.getByTestId(`feed-post-${findId}`);
    await expect(nova.getByLabel('AI, Explainer')).toBeVisible();
    await expect(page.getByTestId('feed-people-only')).toContainText('VOTES COME FROM PEOPLE ONLY · AGENTS CAN’T VOTE');
    // Three tabs and no Rising; no karma, no leaderboard, no score.
    await expect(page.getByTestId('feed-sort-hot')).toBeVisible();
    await expect(page.getByTestId('feed-sort-new')).toBeVisible();
    await expect(page.getByTestId('feed-sort-top')).toBeVisible();
    await expect(page.getByTestId('feed-screen').getByText(/rising|karma|leaderboard|downvote/i)).toHaveCount(0);

    // A source is a plain link to its address, opened in a new tab without an opener.
    const source = page.getByTestId(`feed-post-${sourcePostId}`).getByTestId('feed-post-source');
    await expect(source).toContainText('nature.com');
    await expect(source).toContainText('https://www.nature.com/articles/s41586-020-2649-2');
    await expect(source).toHaveAttribute('href', 'https://www.nature.com/articles/s41586-020-2649-2');
    await expect(source).toHaveAttribute('target', '_blank');
    await expect(source).toHaveAttribute('rel', /noopener/);
    await shoot(page, `${name}-feed-posts`);
    expect(await seriousViolations(page)).toEqual([]);

    // A vote is one tap on a number; the label says which it will do, and the same tap takes it back.
    const vote = reel.getByTestId('feed-vote');
    await expect(vote).toHaveAccessibleName('6 votes. Vote up');
    await vote.click();
    await expect(vote).toHaveAccessibleName('7 votes. You voted. Take your vote back');
    await expect(reel.getByTestId('feed-vote-count')).toHaveText('7');
    expect(calls.filter((call) => call.path === '/v1/rooms/feed/vote').at(-1)?.body).toMatchObject({
      discussionId: deviPostId,
      voted: true,
    });
    // The order does not move under the thumb.
    const whileVoting = await order(page);
    await shoot(page, `${name}-feed-voted`);
    await vote.click();
    await expect(vote).toHaveAccessibleName('6 votes. Vote up');
    expect(await order(page)).toEqual(whileVoting);

    // New is newest first; Top is most votes first; the window shows under Top only.
    await page.getByTestId('feed-sort-new').click();
    await expect(page.getByTestId('feed-sort-new')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await order(page))[0]).toBe(deviPostId);
    await expect(page.getByTestId('feed-window-week')).toHaveCount(0);
    await page.getByTestId('feed-sort-top').click();
    await expect(page.getByTestId('feed-window-week')).toBeVisible();
    await expect.poll(async () => (await order(page))[0]).toBe(findId);
    await page.getByTestId('feed-window-month').click();
    await expect
      .poll(() => calls.filter((call) => call.path === '/v1/rooms/feed/read').at(-1)?.body)
      .toMatchObject({
        sort: 'top',
        window: 'month',
      });
    await shoot(page, `${name}-feed-top`);
    expect(await seriousViolations(page)).toEqual([]);
  });
}

test('phone: a member posts a find with a source, sees it in the Feed as theirs, and cannot vote on it', async ({
  page,
}) => {
  const world = feedWorld({ memberPosts: true });
  const { calls } = await openFeed(page, VIEWPORTS[0].size, world);
  await page.getByTestId('feed-post-open').click();
  const sheet = page.getByTestId('post-sheet');
  await expect(sheet).toBeVisible();
  // Post waits for a headline, words and a link, and says the words are the member's own.
  await expect(page.getByTestId('post-send')).toBeDisabled();
  await expect(sheet).toContainText('no AI writes or changes them');
  await page.getByTestId('post-title').fill('The arc at the edge');
  await page
    .getByTestId('post-words')
    .fill('The arc near the middle is a far galaxy, stretched by mass in front of it.');
  // A link in the words is not allowed: the one link is the checked source.
  await page.getByTestId('post-mode-source').click();
  await page.getByTestId('post-source').fill('https://example.org/lensing');
  await expect(page.getByTestId('post-send')).toBeEnabled();
  await page.waitForTimeout(300);
  await shoot(page, 'phone-post-sheet');
  expect(await seriousViolations(page)).toEqual([]);
  await page.getByTestId('post-send').click();
  await expect(sheet).toHaveCount(0);
  expect(calls.find((call) => call.path === '/v1/rooms/feed/post')?.body).toMatchObject({
    title: 'The arc at the edge',
    link: { kind: 'source', url: 'https://example.org/lensing' },
  });
  const mine = page.getByTestId('feed-list').locator('[role="article"]', { hasText: 'The arc at the edge' });
  await expect(mine).toContainText('You');
  await expect(mine.getByTestId('feed-post-source')).toContainText('example.org');
  await expect(mine.getByTestId('feed-vote')).toHaveAccessibleName('0 votes. Your own post');
  await shoot(page, 'phone-feed-own-post');
  expect(await seriousViolations(page)).toEqual([]);
});

test('phone: a post the room already has opens that post, and a fourth post of the day says to wait', async ({
  page,
}) => {
  const world = feedWorld({ memberPosts: true, nextPost: 'already_there' });
  await openFeed(page, VIEWPORTS[0].size, world);
  const fill = async () => {
    await page.getByTestId('post-title').fill('Same again');
    await page.getByTestId('post-words').fill('Words.');
    await page.getByTestId('post-mode-source').click();
    await page.getByTestId('post-source').fill('https://example.org/same');
  };
  await page.getByTestId('feed-post-open').click();
  await fill();
  await page.getByTestId('post-send').click();
  await expect(page.getByTestId('post-existing')).toContainText('already has a post about that');
  await shoot(page, 'phone-post-already-there');
  await page.getByTestId('post-existing-open').click();
  await expect(page).toHaveURL(new RegExp(`/t/${deviPostId}$`));
  await page.goBack();
  world.nextPost = 'rate_limited';
  await page.getByTestId('feed-post-open').click();
  await page.getByTestId('post-send').click();
  await expect(page.getByTestId('post-sheet')).toContainText('posted as much as one room takes in a day');
  expect(await seriousViolations(page)).toEqual([]);
});

test('phone: a reader whose AI is Off still reads and votes on members’ posts, and the feed says no find was listed', async ({
  page,
}) => {
  await openFeed(page, VIEWPORTS[0].size, feedWorld({ memberPosts: true, aiLevel: 'off' }));
  await expect(page.getByTestId(`feed-post-${deviPostId}`)).toBeVisible();
  await expect(page.getByTestId(`feed-post-${findId}`)).toHaveCount(0);
  await expect(page.getByTestId('feed-empty')).toHaveCount(0);
  await page.getByTestId(`feed-post-${deviPostId}`).getByTestId('feed-vote').click();
  await expect(page.getByTestId(`feed-post-${deviPostId}`).getByTestId('feed-vote-count')).toHaveText('7');
});

test('phone: a reader with no posts left today is not offered Post', async ({ page }) => {
  await openFeed(page, VIEWPORTS[0].size, feedWorld({ memberPosts: true, canPost: false }));
  await expect(page.getByTestId('feed-post-open')).toHaveCount(0);
  await expect(page.getByTestId(`feed-post-${deviPostId}`)).toBeVisible();
});
