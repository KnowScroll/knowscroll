import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { id } from './encounter-fixture';
import { deviPostId, feedRoutes, feedWorld, findId, introId, liveStrip, type FeedWorld } from './rooms-feed-fixture';
import { roomFixture } from './rooms-fixture';

/**
 * People and residents together (v3 R-8b, T3 "Rooms with residents", "A new resident", "Nova's profile") in the production export over
 * labelled HTTP fixtures. The live strip above General says who posted and who replied and nothing about who is here; a resident's
 * profile says who made it, what it cares about and when it last spoke and may post next, and has Mute and Report; a moderator has a
 * resident introduce itself once; every AI label wears the ring, which a screen reader reads. Axe covers names, roles and contrast at
 * 390 and 1440. With `KS_ROOM_SHOTS` set to a folder, each step also saves a screenshot there (never inside the repository).
 */
const shotsFolder = process.env['KS_ROOM_SHOTS'];
async function shoot(page: Page, name: string) {
  if (shotsFolder === undefined) return;
  mkdirSync(shotsFolder, { recursive: true });
  await page.screenshot({ path: join(shotsFolder, `${name}.png`) });
}

async function seriousViolations(page: Page) {
  const results = await new AxeBuilder({ page })
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
    live: () => liveStrip(world),
  });
  const { calls } = await feedRoutes(page, world, scope);
  await page.goto(address);
  return { calls };
}

for (const { name, size } of VIEWPORTS) {
  test(`${name}: the live strip says who posted and who replied, and a resident's profile says who made it and when it last spoke`, async ({
    page,
  }) => {
    const world = feedWorld({ memberPosts: true });
    const { calls } = await open(page, size, world);

    // The strip: real events, newest first, each opening its post; no number of people.
    const strip = page.getByTestId('now-strip');
    await expect(page.getByTestId('now-feed')).toContainText('Omar');
    await expect(page.getByTestId('now-feed')).toContainText('replied · ');
    await expect(page.getByTestId('now-feed-1')).toContainText('Devi');
    await expect(page.getByTestId('now-feed-1')).toContainText('posted · ');
    await expect(strip.getByText(/\bonline\b|here now|people here/i)).toHaveCount(0);
    await shoot(page, `${name}-live-strip`);
    expect(await seriousViolations(page)).toEqual([]);

    await page.getByTestId('now-feed-open').click();
    await expect(page).toHaveURL(/\/feed$/);
    // The ring is on every AI label in the Feed, with a name of its own, and never on a person.
    const nova = page.getByTestId(`feed-post-${findId}`);
    await expect(nova.getByLabel('Agent ring')).toHaveCount(1);
    await expect(page.getByTestId(`feed-post-${deviPostId}`).getByLabel('Agent ring')).toHaveCount(0);
    await shoot(page, `${name}-feed-ring`);

    // The profile.
    await page.getByTestId('feed-resident-explainer').click();
    const sheet = page.getByTestId('resident-sheet');
    await expect(sheet).toBeVisible();
    await expect(page.getByTestId('resident-made-by')).toContainText('AGENT · MADE BY KNOWSCROLL');
    await expect(page.getByTestId('resident-since')).toContainText('Lives in Space room since 2 Oct');
    await expect(page.getByTestId('resident-interests')).toContainText('Plain explanations');
    await expect(page.getByTestId('resident-last')).toContainText('LAST ');
    await expect(page.getByTestId('resident-next')).toContainText('NEXT AFTER ');
    await expect(page.getByTestId('resident-recent')).toContainText('Light that bends around something we can’t see');
    await expect(sheet.getByLabel('Agent ring').first()).toBeVisible();
    await expect(sheet).toContainText('The ring next to a name means agent. It can’t be removed or hidden.');
    await page.waitForTimeout(300);
    await shoot(page, `${name}-resident-profile-people`);
    expect(await seriousViolations(page)).toEqual([]);

    // Mute is the member's own AI level for the room, and says so; the Feed then lists no find.
    await expect(page.getByTestId('resident-mute')).toHaveText('Mute residents here');
    await page.getByTestId('resident-mute').click();
    expect(calls.find((call) => call.path === '/v1/rooms/preferences')?.body).toMatchObject({ aiLevel: 'off' });
    await expect(page.getByTestId('resident-mute')).toHaveText('Unmute residents here');
    await page.getByTestId('resident-mute').click();
    await expect(page.getByTestId('resident-mute')).toHaveText('Mute residents here');
  });
}

test('phone: Report opens the report for the resident’s newest post', async ({ page }) => {
  await open(page, VIEWPORTS[0].size, feedWorld({ memberPosts: true }));
  await page.getByTestId('now-feed-open').click();
  await page.getByTestId('feed-resident-explainer').click();
  await page.getByTestId('resident-report').click();
  await expect(page.getByTestId('feedback-sheet')).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
});

test('phone: a moderator has a resident introduce itself once, and it appears in the Feed as the resident’s own labelled post', async ({
  page,
}) => {
  const world = feedWorld({ memberPosts: true, canEditMemory: true });
  const { calls } = await open(page, VIEWPORTS[0].size, world);
  await page.getByTestId('now-feed-open').click();
  await page.getByTestId('feed-resident-explainer').click();
  await expect(page.getByTestId('resident-introduce')).toContainText('can introduce itself once');
  await page.getByTestId('resident-introduce-button').click();
  expect(calls.find((call) => call.path === '/v1/rooms/feed/introduce')?.body).toMatchObject({
    inhabitant: 'explainer',
  });
  // It is done: the offer goes, and the introduction is a post under the Feed's own order.
  await expect(page.getByTestId('resident-introduce')).toHaveCount(0);
  await page.keyboard.press('Escape');
  const intro = page.getByTestId(`feed-post-${introId}`);
  await expect(intro).toBeVisible();
  await expect(intro).toContainText('A NEW RESIDENT');
  await expect(intro).toContainText('Introduced by the room’s mods · one introduction, no follow-up hellos');
  await expect(intro.getByLabel('AI, Explainer')).toBeVisible();
  await expect(intro.getByLabel('Agent ring')).toHaveCount(1);
  await shoot(page, 'phone-introduction');
  expect(await seriousViolations(page)).toEqual([]);
});

test('phone: a member who is not a moderator is offered no introduction', async ({ page }) => {
  await open(page, VIEWPORTS[0].size, feedWorld({ memberPosts: true }));
  await page.getByTestId('now-feed-open').click();
  await page.getByTestId('feed-resident-explainer').click();
  await expect(page.getByTestId('resident-sheet')).toBeVisible();
  await expect(page.getByTestId('resident-introduce')).toHaveCount(0);
});
