import { expect, test, type Page } from '@playwright/test';
import { sceneFixture, fixtureAccount } from '../features/universe/universe.fixture';
import { signedInAccount } from './account-fixture';
import { emptyInbox, isInboxPath } from './empty-inbox';
import { encounterFixture } from './encounter-fixture';
import { talkFixture, thread } from './talk-fixture';

/**
 * Keyboard-only use of the production export over labelled HTTP fixtures: every stop of the Tab
 * order shows where focus is, and the main journeys (Explore, a sheet, the Universe, Talk, Privacy)
 * work without a pointer. The keys are the ones in the keyboard map (`features/shell/keyboard-map.tsx`).
 */

interface Stop {
  readonly name: string;
  readonly visible: boolean;
}

/** Tabs through the page and reports each stop and whether focus is drawn on it (an outline, a shadow or a coloured edge). */
async function focusStops(page: Page, limit = 60): Promise<Stop[]> {
  const stops: Stop[] = [];
  for (let index = 0; index < limit; index += 1) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const element = document.activeElement;
      if (element === null || element === document.body) return undefined;
      const style = getComputedStyle(element);
      const outline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
      const shadow = style.boxShadow !== 'none';
      const edge = element.matches('input, textarea') && style.borderColor !== 'rgb(17, 17, 17)';
      const name =
        element.getAttribute('aria-label') ?? element.getAttribute('data-testid') ?? (element.textContent ?? '').trim();
      return { name: name.slice(0, 60), visible: outline || shadow || edge };
    });
    if (stop === undefined) break;
    if (stops.length > 0 && stop.name === stops[0]?.name) break;
    stops.push(stop);
  }
  return stops;
}

const unseen = (stops: readonly Stop[]) => stops.filter((stop) => !stop.visible).map((stop) => stop.name);

test('every Tab stop of the main screens draws focus', async ({ page }) => {
  await signedInAccount(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const route of ['/saved', '/conversations', '/account', '/account/privacy', '/friends']) {
    await page.goto(route);
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    const stops = await focusStops(page);
    expect(stops.length, `${route} has focus stops`).toBeGreaterThan(2);
    expect(unseen(stops), `${route}: stops that draw no focus`).toEqual([]);
  }
});

test('Explore by keyboard: the stage moves between subjects and parts, the switch changes format, a sheet closes on Escape with focus back', async ({
  page,
}) => {
  const { commands } = await encounterFixture(page, 'reel', { viewport: { width: 1440, height: 900 }, series: true });
  await page.route('**/media/gesture-fixture', (route) => route.fulfill({ status: 404, body: 'fixture only' }));
  await page.goto('/explore');
  const caption = page.getByTestId('encounter-reel-caption');
  await expect(caption).toContainText('CI encounter fixture 1');
  const stops = await focusStops(page, 30);
  expect(unseen(stops), 'Explore: stops that draw no focus').toEqual([]);
  const navigations = () => commands.filter((call) => call.path === '/v1/experience/navigate');

  // Focus reaches the stage by Tab, as for a keyboard user, and stays with it after each move:
  // ↓ is the next subject, → the next part of the thread.
  await page.goto('/explore');
  await expect(caption).toContainText('CI encounter fixture 1');
  for (let tabs = 0; tabs < 30; tabs += 1) {
    await page.keyboard.press('Tab');
    if (await page.getByTestId('reel-navigation-stage').evaluate((node) => node === document.activeElement)) break;
  }
  await expect(page.getByTestId('reel-navigation-stage')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(caption).toContainText('CI encounter fixture 2');
  expect(navigations().at(-1)?.body['intent']).toEqual({ mode: 'vertical', direction: 'next', format: 'reel' });
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => navigations().at(-1)?.body['intent']).toMatchObject({ mode: 'series', direction: 'next' });

  // The More sheet opens with Enter and closes on Escape, and focus returns to the control that opened it.
  const more = page.getByRole('button', { name: 'More options' });
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'More', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'More', exact: true })).not.toBeVisible();
  await expect(more).toBeFocused();
});

test('the Universe by keyboard: every stop draws focus, Enter on a place opens it, Enter on Back returns', async ({
  page,
}) => {
  const world = sceneFixture();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/auth/session', (route) =>
    route.fulfill({ json: { account: fixtureAccount, client: 'web', expiresAt: '2099-10-21T00:00:00.000Z' } }),
  );
  await page.route('**/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    if (path === '/v1/privacy/recording/read')
      return route.fulfill({
        json: {
          ...body,
          scope: { accountId: fixtureAccount.accountId, privacyEpoch: 1 },
          revision: 0,
          policy: { on: true, generation: 1 },
        },
      });
    if (isInboxPath(path)) return route.fulfill({ json: emptyInbox(path, body, fixtureAccount.accountId) });
    if (path.endsWith('/formation/read'))
      return route.fulfill({
        json: {
          ...body,
          scope: { universeId: fixtureAccount.universeId, privacyEpoch: 1, personalWatermark: 40 },
          recordedAt: '2026-10-22T00:00:00.000Z',
          currentGeography: { revision: 3, structureRevision: 3, activityRevision: 0 },
          sceneRevision: 7,
          status: 'unavailable',
          reason: 'temporarily_unavailable',
        },
      });
    if (path.startsWith('/v1/universe/')) return route.fulfill({ json: world.reply(path, body) });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto('/universe');
  const place = page.getByRole('button', { name: 'CI system 0, a system', exact: true });
  await expect(place).toBeVisible();
  const stops = await focusStops(page, 30);
  expect(unseen(stops), 'Universe: stops that draw no focus').toEqual([]);
  await place.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'CI system 0', exact: true })).toBeVisible();
  // Back to the whole map is a button, so Enter does it; Escape closes a card or a list, not the place.
  const back = page.getByRole('button', { name: 'Back to Universe' });
  await back.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'CI system 0', exact: true })).toHaveCount(0);
});

test('Talk by keyboard: Tab reaches the episodes, the arrows move between them, the message box is last before the rail', async ({
  page,
}) => {
  await talkFixture(page, { width: 1440, height: 900 });
  await page.goto(`/threads/${thread.threadId}?m=${thread.membershipId}&r=1`);
  await expect(page.getByRole('heading', { level: 1, name: 'CI series' })).toBeVisible();
  const stops = await focusStops(page, 40);
  expect(unseen(stops), 'Thread: stops that draw no focus').toEqual([]);
  const names = stops.map((stop) => stop.name);
  expect(names.indexOf('Thread options')).toBeGreaterThan(-1);
  expect(names.indexOf('Thread options')).toBeLessThan(names.findIndex((name) => /^Message/.test(name)));
  expect(names.at(-1)).toBe('Account and settings');

  // Part 1 is open to begin with; the right arrow in the episode list opens Part 2 and the left arrow Part 1 again.
  const part = (number: number) =>
    page.getByTestId('episode-navigator').getByRole('button', { name: new RegExp(`part ${String(number)}`, 'i') });
  await expect(part(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(part(2)).toHaveAttribute('aria-pressed', 'false');
  await part(1).focus();
  await page.keyboard.press('ArrowRight');
  await expect(part(2)).toHaveAttribute('aria-pressed', 'true');
  await expect(part(1)).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('ArrowLeft');
  await expect(part(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(part(2)).toHaveAttribute('aria-pressed', 'false');
});

test('Privacy by keyboard on a desktop: the recording switch is a switch, and the destructive step asks for an acknowledgement first', async ({
  page,
}) => {
  await signedInAccount(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/account/privacy');
  const recording = page.getByRole('switch', { name: 'Shape my universe from what I watch' });
  await recording.focus();
  await expect(recording).toBeFocused();
  const acknowledge = page.getByRole('checkbox', { name: 'I understand this cannot be undone' }).first();
  await acknowledge.focus();
  await expect(acknowledge).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Space');
  await expect(acknowledge).toHaveAttribute('aria-checked', 'true');
});
