import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { id } from './encounter-fixture';
import { feedRoutes, feedWorld, liveStrip, type FeedWorld } from './rooms-feed-fixture';
import { roomFixture } from './rooms-fixture';

/**
 * The room's General / Feed / Topics bar and ground (v3 R-8c) in the production export over labelled HTTP fixtures. The bar sits
 * under the room header at 390 and 1440, switches in place (no address change, no history entry), keeps each tab's scroll, opens
 * on Feed from `/rooms/<id>/feed`, is driven by the arrow keys, and stands on the room's own ground in the kit's ink (a dark
 * kit and a pale one), with axe clean on each. The live strip's chips keep their time when a name is long. With `KS_ROOM_SHOTS`
 * set to a folder, each step also saves a screenshot there (never inside the repository).
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

async function open(
  page: Page,
  size: { width: number; height: number },
  options: {
    face?: 'space' | 'history' | 'thin';
    world?: FeedWorld;
    path?: string;
    live?: () => Record<string, unknown>[];
  } = {},
) {
  const world = options.world ?? feedWorld({ memberPosts: true });
  const { address } = await roomFixture(page, size, {
    others: 1,
    lastMessageMinutesAgo: 5,
    noticeSeen: true,
    topics: true,
    face: options.face ?? 'space',
    live: options.live ?? (() => liveStrip(world)),
  });
  await feedRoutes(page, world, scope);
  await page.goto(`${address}${options.path ?? ''}`);
  return { address };
}

/**
 * The contrast of the bar's words as drawn: each label against what is behind it in the browser (the ground for a tab that is not
 * open, the tab's own fill for the open one), read from the computed colours so a wash or a fill laid over the ground shows.
 */
async function barContrast(page: Page) {
  const ratio = await page.evaluate(() => {
    const parse = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 4).map(Number);
    const luminance = ([red, green, blue]: number[]) => {
      const [r, g, b] = [red, green, blue].map((channel) => {
        const unit = (channel ?? 0) / 255;
        return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const contrast = (first: number[], second: number[]) => {
      const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
      return (light! + 0.05) / (dark! + 0.05);
    };
    /** The first background up the tree that is not transparent. */
    const behind = (node: Element): number[] => {
      for (let at: Element | null = node; at !== null; at = at.parentElement) {
        const colour = parse(getComputedStyle(at).backgroundColor);
        if (colour.length >= 3 && (colour[3] ?? 1) > 0) return colour;
      }
      return [255, 255, 255];
    };
    const read = (testID: string) => {
      const tab = document.querySelector(`[data-testid="${testID}"]`)!;
      const label = tab.querySelector('div[dir]') ?? tab;
      return contrast(parse(getComputedStyle(label).color), behind(tab));
    };
    return { unselected: read('room-tab-feed'), selected: read('room-tab-general') };
  });
  expect(ratio.unselected).toBeGreaterThanOrEqual(4.5);
  expect(ratio.selected).toBeGreaterThanOrEqual(4.5);
  return { unselected: ratio.unselected, selected: ratio.selected };
}

const selected = (page: Page, tab: 'general' | 'feed' | 'topics') =>
  expect(page.getByTestId(`room-tab-${tab}`)).toHaveAttribute('aria-selected', 'true');

for (const { name, size } of VIEWPORTS) {
  for (const face of ['space', 'history', 'thin'] as const) {
    test(`${name}, ${face} room: the bar switches in place on the room's own ground, and axe finds nothing`, async ({
      page,
    }) => {
      await open(page, size, { face });
      const tabs = page.getByTestId('room-tabs');
      await expect(tabs).toBeVisible();
      await expect(tabs.getByRole('tab')).toHaveText(['General', 'Feed', 'Topics']);
      await selected(page, 'general');
      // The ground is the kit's: dark midnight for the Space room, paper for the History room.
      await expect(page.getByTestId('room-ground')).toHaveCSS(
        'background-color',
        face === 'history' ? 'rgb(244, 237, 216)' : 'rgb(4, 10, 23)',
      );
      await shoot(page, `${name}-${face}-general`);
      expect(await seriousViolations(page)).toEqual([]);
      expect(await barContrast(page)).toEqual({ unselected: expect.any(Number), selected: expect.any(Number) });

      const url = page.url();
      const entries = await page.evaluate(() => history.length);
      await page.getByTestId('room-tab-feed').click();
      await selected(page, 'feed');
      await expect(page.getByTestId('feed-screen')).toBeVisible();
      await expect(page.getByTestId('room-messages')).toBeHidden();
      await shoot(page, `${name}-${face}-feed`);
      expect(await seriousViolations(page)).toEqual([]);

      await page.getByTestId('room-tab-topics').click();
      await selected(page, 'topics');
      await expect(page.getByTestId('topics-screen')).toBeVisible();
      await expect(page.getByTestId('feed-screen')).toBeHidden();
      await expect(page.getByTestId('topics-screen').getByTestId('new-topic')).toBeVisible();
      await shoot(page, `${name}-${face}-topics`);
      expect(await seriousViolations(page)).toEqual([]);

      await page.getByTestId('room-tab-general').click();
      await selected(page, 'general');
      await expect(page.getByTestId('room-messages')).toBeVisible();
      // Nothing was navigated: the same address and no new entry in the history.
      expect(page.url()).toBe(url);
      expect(await page.evaluate(() => history.length)).toBe(entries);
    });
  }

  test(`${name}: Back leaves the room, not the tab`, async ({ page }) => {
    await page.goto('about:blank');
    await open(page, size);
    await page.getByTestId('room-tab-feed').click();
    await selected(page, 'feed');
    await page.getByTestId('room-tab-topics').click();
    await selected(page, 'topics');
    await page.goBack();
    await expect(page).toHaveURL('about:blank');
  });

  test(`${name}: a deep link to the feed opens on the Feed tab`, async ({ page }) => {
    await open(page, size, { path: '/feed' });
    await selected(page, 'feed');
    await expect(page.getByTestId('feed-screen')).toBeVisible();
    await expect(page.getByTestId('feed-list')).toBeVisible();
    // General is one tab away, and the Now strip's Feed chip opens the same tab without leaving.
    await page.getByTestId('room-tab-general').click();
    await expect(page.getByTestId('now-feed-open')).toBeVisible();
    await page.getByTestId('now-feed-open').click();
    await selected(page, 'feed');
    expect(await seriousViolations(page)).toEqual([]);
  });

  test(`${name}: the arrow keys, Home and End move between the tabs`, async ({ page }) => {
    await open(page, size);
    await page.getByTestId('room-tab-general').focus();
    await page.keyboard.press('ArrowRight');
    await selected(page, 'feed');
    await expect(page.getByTestId('room-tab-feed')).toBeFocused();
    await page.keyboard.press('End');
    await selected(page, 'topics');
    await page.keyboard.press('ArrowRight');
    await selected(page, 'general');
    await page.keyboard.press('ArrowLeft');
    await selected(page, 'topics');
    await page.keyboard.press('Home');
    await selected(page, 'general');
    // One Tab stop for the bar: the open tab.
    await expect(page.getByTestId('room-tab-general')).toHaveAttribute('tabindex', '0');
    await expect(page.getByTestId('room-tab-feed')).toHaveAttribute('tabindex', '-1');
  });
}

test('phone: each tab keeps its scroll when another is opened and the first is opened again', async ({ page }) => {
  // A short window, so that General and the Feed both have more than a screen to scroll.
  await open(page, { width: 390, height: 520 });
  const scrollOf = (testID: string) => page.getByTestId(testID).evaluate((node) => node.scrollTop);
  const scrollTo = (testID: string, top: number) =>
    page.getByTestId(testID).evaluate((node, value) => {
      node.scrollTop = value;
    }, top);

  await page.getByTestId('room-tab-feed').click();
  await expect(page.getByTestId('feed-list')).toBeVisible();
  const room = await page.getByTestId('feed-screen').evaluate((node) => node.scrollHeight - node.clientHeight);
  expect(room).toBeGreaterThan(80);
  await scrollTo('feed-screen', 80);
  await expect.poll(() => scrollOf('feed-screen')).toBe(80);

  await page.getByTestId('room-tab-general').click();
  await expect(page.getByTestId('room-messages')).toBeVisible();
  const before = await scrollOf('room-messages');
  await scrollTo('room-messages', Math.max(0, before - 40));
  const general = await scrollOf('room-messages');

  await page.getByTestId('room-tab-topics').click();
  await page.getByTestId('room-tab-feed').click();
  await expect.poll(() => scrollOf('feed-screen')).toBe(80);
  await page.getByTestId('room-tab-general').click();
  expect(await scrollOf('room-messages')).toBe(general);
});

test('phone: the live strip keeps the time when a name is long, and says all of it to a screen reader', async ({
  page,
}) => {
  const longName = 'Bartholomew-Alexander Featherstonehaugh';
  const world = feedWorld({ memberPosts: true });
  await open(page, VIEWPORTS[0].size, {
    world,
    live: () => [
      {
        kind: 'replied',
        by: {
          kind: 'person',
          person: { kind: 'person', personId: id(570), handle: 'long', displayName: longName },
          you: false,
        },
        at: new Date(Date.now() - 6 * 60_000).toISOString(),
        discussionId: id(571),
      },
    ],
  });
  const chip = page.getByTestId('now-feed');
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute('aria-label', `Feed, ${longName} replied · 6 min ago`);
  // The name gives way; "replied · 6 min ago" is whole.
  const detail = chip.getByText('replied · 6 min ago');
  await expect(detail).toBeVisible();
  expect(await detail.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  const box = await chip.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(281);
  await shoot(page, 'phone-live-strip-long-name');
  expect(await seriousViolations(page)).toEqual([]);
});

for (const { name, size } of VIEWPORTS) {
  test(`${name}: keyboard focus on a dark kit’s ground is cobalt between two bands of white, and the bar does not clip it`, async ({
    page,
  }) => {
    await open(page, size);
    const ringOf = (testID: string) =>
      page.getByTestId(testID).evaluate((node) => {
        const style = getComputedStyle(node);
        return { outline: style.outlineColor, width: style.outlineWidth, shadow: style.boxShadow };
      });
    await page.getByTestId('room-tab-general').focus();
    await page.keyboard.press('ArrowRight');
    await selected(page, 'feed');
    const tab = await ringOf('room-tab-feed');
    expect(tab.outline).toBe('rgb(44, 70, 232)');
    expect(tab.width).toBe('3px');
    expect(tab.shadow).toContain('rgb(255, 255, 255)');
    // The bar and its frame leave the ring room to be drawn.
    expect(await page.getByTestId('room-tabs').evaluate((node) => getComputedStyle(node).overflow)).toBe('visible');
    await shoot(page, `${name}-tab-focus`);

    // A control on the ground itself (the Feed's sort) and a button in the panel draw the same ring.
    await page.getByTestId('feed-sort-new').focus();
    const sort = await ringOf('feed-sort-new');
    expect(sort.outline).toBe('rgb(44, 70, 232)');
    expect(sort.shadow).toContain('rgb(255, 255, 255)');
    await shoot(page, `${name}-sort-focus`);
  });
}

test('a pale kit’s ground draws the plain cobalt ring', async ({ page }) => {
  await open(page, VIEWPORTS[0].size, { face: 'history' });
  await page.getByTestId('room-tab-general').focus();
  await page.keyboard.press('ArrowRight');
  const shadow = await page.getByTestId('room-tab-feed').evaluate((node) => getComputedStyle(node).boxShadow);
  expect(shadow).toBe('none');
});
