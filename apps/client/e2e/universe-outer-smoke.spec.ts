import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { fixtureAccount, fixtureId } from '../features/universe/universe.fixture';
import { landed, openVoyage, shot, VOYAGE_READS } from './voyage-fixture';

/**
 * The Universe's outer stop (#811, Round 7.3), in a real browser over authored HTTP fixtures: past the rim of your
 * universe your friends' universes stand round it. It is reached by a pinch, a wheel notch or `-`, left by the Back pill,
 * Escape or the browser's Back, and a friend's button is a visit. Nothing about it is stored, and with "Try the new
 * Universe" off the Universe does what it always did. The roster read is the Friends list's own, answered here.
 */

const stageOf = (page: Page) => page.getByTestId('voyage-stage');
const heading = (page: Page, name: string) => page.getByRole('heading', { level: 1, name, exact: true });
const friendButtons = (page: Page) => page.locator('[data-testid^="outer-friend-"]');

/** The friends a roster answers with: `Friend 0` (`friend0`), `Friend 1` ... */
const rosterOf = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    state: 'friends',
    peer: {
      kind: 'person',
      personId: fixtureId(2000 + index),
      handle: `friend${index}`,
      displayName: `Friend ${index}`,
    },
    pairRevision: 1,
    availability: { state: 'unknown' },
  }));

/**
 * Opens the Universe with the trial on and answers the Friends list's page read with `friends` friends. Returns each
 * page of the roster that was asked for, so a spec can say when it was read (the bar's own reads are not counted). Registered after `openVoyage`, whose catch-all it must win over.
 */
async function openOuter(
  page: Page,
  options: { friends?: number; size?: { width: number; height: number }; trial?: boolean; calm?: boolean } = {},
): Promise<{ readonly roster: string[]; readonly paths: string[] }> {
  const paths: string[] = [];
  const roster: string[] = [];
  await openVoyage(page, paths, {
    ...(options.size ? { size: options.size } : {}),
    ...(options.trial === undefined ? {} : { trial: options.trial }),
    ...(options.calm === true ? { calm: true } : {}),
  });
  await page.route('**/v1/social/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    if (path.endsWith('/friends/page')) roster.push(path);
    if (path.endsWith('/friends/page'))
      return route.fulfill({
        json: {
          version: 'friend-pages.v2',
          requestId: body['requestId'],
          scope: { accountId: fixtureAccount.accountId, privacyEpoch: fixtureAccount.privacyEpoch },
          filter: body['filter'],
          snapshotRevision: 1,
          items: body['filter'] === 'friends' ? rosterOf(options.friends ?? 14) : [],
        },
      });
    return route.fulfill({ status: 404, json: {} });
  });
  await expect(page.getByRole('button', { name: 'CI system 0, a system', exact: true })).toBeVisible({
    timeout: 60_000,
  });
  return { roster, paths };
}

/** Gives the stage the keyboard, so a key reaches it. */
async function onStage(page: Page): Promise<void> {
  await stageOf(page).focus();
}

/** Goes past the rim by the key, and waits for the field. */
async function goOut(page: Page): Promise<void> {
  await onStage(page);
  await page.keyboard.press('-');
  await expect(heading(page, 'Beyond your universe')).toBeVisible();
  await landed(page);
  await expect(friendButtons(page).first()).toBeVisible({ timeout: 30_000 });
}

/** Where a locator's box is, on the page. */
async function boxOf(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('No box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** The handles of the friends on screen. */
const handlesOf = (page: Page): Promise<string[]> =>
  friendButtons(page).evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute('data-testid')!.replace('outer-friend-', '')),
  );

async function seriousViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(' | ')}`);
}

test.describe('on a phone', () => {
  const size = { width: 390, height: 844 };

  test('goes past the rim by the wheel, shows the friends, and leaves by the Back pill, Escape and the browser’s Back', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const { roster, paths } = await openOuter(page, { size });
    await expect(heading(page, 'Your universe')).toBeVisible();
    // Nothing is read until the person goes out.
    expect(roster).toEqual([]);

    await page.mouse.move(195, 422);
    await page.mouse.wheel(0, 120);
    await expect(heading(page, 'Beyond your universe')).toBeVisible();
    await landed(page);
    await expect(page.getByTestId('outer-line')).toHaveText('14 friends', { timeout: 30_000 });
    expect(roster.some((path) => path.endsWith('/friends/page'))).toBe(true);
    await shot(page, 'outer-phone-stop');

    // The friends are buttons, five to ten of them; the unnamed universes are neither buttons nor in the tree.
    await expect(friendButtons(page).first()).toBeVisible();
    const shown = await friendButtons(page).count();
    expect(shown).toBeGreaterThanOrEqual(5);
    expect(shown).toBeLessThanOrEqual(10);
    await expect(page.getByRole('button', { name: /^Friend \d+’s universe$/ })).toHaveCount(shown);
    await expect(page.getByRole('button', { name: 'All friends (14)', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Back to Your universe', exact: true })).toBeVisible();
    // Return to ... and the rest of the chips are for your own universe: none of them is here.
    await expect(page.getByRole('button', { name: /^Return to / })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'List view', exact: true })).toHaveCount(0);

    // Another notch out does nothing: there is nothing farther out, and no extra step is left in Back.
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(500);
    await expect(heading(page, 'Beyond your universe')).toBeVisible();

    // The Back pill comes back to your universe, and the friends go with the flight.
    await page.getByRole('button', { name: 'Back to Your universe', exact: true }).click();
    await expect(heading(page, 'Your universe')).toBeVisible();
    await landed(page);
    await expect(friendButtons(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^All friends/ })).toHaveCount(0);

    // Escape leaves too.
    await goOut(page);
    await page.keyboard.press('Escape');
    await expect(heading(page, 'Your universe')).toBeVisible();
    await landed(page);

    // And so does the browser's Back, which stays on the Universe.
    await goOut(page);
    await page.goBack();
    await expect(heading(page, 'Your universe')).toBeVisible();
    await expect(page).toHaveURL(/\/universe$/);
    await landed(page);
    expect(paths.filter((path) => !VOYAGE_READS.has(path))).toEqual([]);
  });

  test('a friend’s button is a visit, the list holds every friend, and Back closes the list before the stop', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await openOuter(page, { size });
    await goOut(page);
    await expect(page.getByTestId('outer-line')).toHaveText('14 friends');

    // The list is the way to every friend: a real list over the stage, scrollable, named for each.
    await page.getByRole('button', { name: 'All friends (14)', exact: true }).click();
    const sheet = page.getByTestId('outer-friends-sheet');
    await expect(sheet).toBeVisible();
    await expect(page.locator('[data-testid^="outer-row-"]')).toHaveCount(14);
    await shot(page, 'outer-phone-list');
    // Escape closes only the list.
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(heading(page, 'Beyond your universe')).toBeVisible();
    // So does the browser's Back, which was the list's, and then the stop's own.
    await page.getByRole('button', { name: 'All friends (14)', exact: true }).click();
    await expect(sheet).toBeVisible();
    await page.goBack();
    await expect(sheet).toHaveCount(0);
    await expect(heading(page, 'Beyond your universe')).toBeVisible();

    // A row goes to that friend's universe.
    await page.getByRole('button', { name: 'All friends (14)', exact: true }).click();
    await page.getByTestId('outer-row-friend13').click();
    await expect(page).toHaveURL(/\/visit\/friend13$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/universe$/);
    // Coming back lands on your universe, not out among the friends: the visit left the stop.
    await expect(heading(page, 'Your universe')).toBeVisible();

    // A button on the field goes there too, and the address stays the visit's.
    await goOut(page);
    const first = (await handlesOf(page))[0]!;
    await page.getByTestId(`outer-friend-${first}`).click();
    await expect(page).toHaveURL(new RegExp(`/visit/${first}$`));
    await page.waitForTimeout(1500);
    await expect(page).toHaveURL(new RegExp(`/visit/${first}$`));
  });

  test('has no accessibility violations at the stop, and none of its decoration is in the tree', async ({ page }) => {
    test.setTimeout(240_000);
    await openOuter(page, { size });
    await goOut(page);
    await page.waitForTimeout(800);
    expect(await seriousViolations(page)).toEqual([]);
    // The drawing (the unnamed universes, the web, the initials and the names under the bubbles) is out of reach of a
    // screen reader: the buttons name every friend, and the header says the rest.
    const drawing = page.getByTestId('outer-drawing');
    await expect(drawing).toHaveAttribute('aria-hidden', 'true');
    expect(await drawing.locator('button, a, [role="button"]').count()).toBe(0);
    const tree = await page.locator('body').ariaSnapshot();
    expect(tree).not.toMatch(/\bo[0-6]\b/);
    for (const name of await friendButtons(page).evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute('aria-label')),
    ))
      // Each friend is heard once: as their button, not again as a name drawn beside it.
      expect(tree.split(`${name!}`).length - 1, name!).toBe(1);
    await page.getByRole('button', { name: 'All friends (14)', exact: true }).click();
    await expect(page.getByTestId('outer-friends-sheet')).toBeVisible();
    await page.waitForTimeout(600);
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('says when the friends cannot be read, and tries again', async ({ page }) => {
    test.setTimeout(240_000);
    await openVoyage(page, [], { size });
    let failing = true;
    await page.route('**/v1/social/**', (route) => {
      if (failing) return route.fulfill({ status: 503, json: {} });
      const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
      return route.fulfill({
        json: {
          version: 'friend-pages.v2',
          requestId: body['requestId'],
          scope: { accountId: fixtureAccount.accountId, privacyEpoch: fixtureAccount.privacyEpoch },
          filter: body['filter'],
          snapshotRevision: 1,
          items: rosterOf(3),
        },
      });
    });
    await expect(page.getByRole('button', { name: 'CI system 0, a system', exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await onStage(page);
    await page.keyboard.press('-');
    await expect(page.getByTestId('outer-line')).toContainText(/Couldn’t load your friends|You are offline/, {
      timeout: 30_000,
    });
    failing = false;
    await page.getByTestId('outer-retry').click();
    await expect(page.getByTestId('outer-line')).toHaveText('3 friends', { timeout: 30_000 });
    await expect(friendButtons(page)).toHaveCount(3);
  });
});

test.describe('on a desktop', () => {
  const size = { width: 1440, height: 900 };

  test('goes past the rim by `-` and by the wheel, says its keys, and pans with the arrows and a drag', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await openOuter(page, { size, friends: 40 });
    await onStage(page);
    await page.keyboard.press('-');
    await expect(heading(page, 'Beyond your universe')).toBeVisible();
    await landed(page);
    await expect(friendButtons(page).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('outer-line')).toHaveText('40 friends');
    await expect(page.getByRole('button', { name: 'All friends (40)', exact: true })).toBeVisible();
    await shot(page, 'outer-desktop-stop');

    // The keys say what they do here, and only that.
    const hints = page.getByTestId('universe-key-hints');
    await expect(hints).toContainText('look round');
    await expect(hints).toContainText('back to your universe');
    await expect(hints).not.toContainText('fly the ship');

    // Looking right slides the field left: a friend's button moves the other way by the press (60 points).
    const before = await handlesOf(page);
    const anchor = before[0]!;
    const at = await boxOf(page.getByTestId(`outer-friend-${anchor}`));
    await onStage(page);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);
    const moved = await boxOf(page.getByTestId(`outer-friend-${anchor}`));
    expect(moved.x - at.x).toBeCloseTo(-60, 0);
    // Not up or down (a few points of the ship's own lean may settle with it).
    expect(Math.abs(moved.y - at.y)).toBeLessThan(10);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(300);
    const back = await boxOf(page.getByTestId(`outer-friend-${anchor}`));
    expect(back.x - at.x).toBeCloseTo(60, 0);
    // The field is panned and nothing is stored: no step was added to Back.
    await expect(heading(page, 'Beyond your universe')).toBeVisible();

    // A drag on the sky moves it with the pointer, one to one, and other friends come into view.
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(200);
    const rest = await boxOf(page.getByTestId(`outer-friend-${anchor}`));
    await page.mouse.move(1200, 760);
    await page.mouse.down();
    await page.mouse.move(1160, 740, { steps: 6 });
    await page.mouse.move(1100, 720, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const dragged = await handlesOf(page);
    expect(dragged.length).toBeLessThanOrEqual(10);
    if (dragged.includes(anchor)) {
      const after = await boxOf(page.getByTestId(`outer-friend-${anchor}`));
      // With the pointer, one to one (the pan is held where five friends still show, so it may stop short of 100 and 40).
      expect(after.x - rest.x).toBeLessThan(-30);
      expect(after.x - rest.x).toBeGreaterThanOrEqual(-100.5);
      expect(after.y - rest.y).toBeLessThanOrEqual(0);
    }
    await shot(page, 'outer-desktop-panned');

    // Escape leaves, and the field is at rest the next time.
    await page.keyboard.press('Escape');
    await expect(heading(page, 'Your universe')).toBeVisible();
    await landed(page);
    await page.mouse.move(720, 450);
    await page.mouse.wheel(0, 120);
    await expect(heading(page, 'Beyond your universe')).toBeVisible();
    await landed(page);
    await expect(friendButtons(page).first()).toBeVisible({ timeout: 30_000 });
    const again = await boxOf(page.getByTestId(`outer-friend-${anchor}`));
    expect(again.x).toBeCloseTo(at.x, 0);
    await onStage(page);
    await page.keyboard.press('+');
    await expect(heading(page, 'Your universe')).toBeVisible();
  });

  test('has no accessibility violations at the stop', async ({ page }) => {
    test.setTimeout(240_000);
    await openOuter(page, { size });
    await goOut(page);
    await page.waitForTimeout(800);
    expect(await seriousViolations(page)).toEqual([]);
  });
});

test.describe('by a pinch on a touch screen', () => {
  test.use({ hasTouch: true, isMobile: true });
  const size = { width: 390, height: 844 };

  /** Two fingers on the stage, `from` px apart, taken to `to`; lifted unless `hold`. */
  async function pinch(page: Page, from: number, to: number, hold = false): Promise<void> {
    const cdp = await page.context().newCDPSession(page);
    const at = { x: 195, y: 422 };
    const fingers = (spread: number) => [
      { x: at.x - spread / 2, y: at.y, id: 0 },
      { x: at.x + spread / 2, y: at.y, id: 1 },
    ];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: fingers(from) });
    for (let step = 1; step <= 8; step += 1)
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: fingers(from + ((to - from) * step) / 8),
      });
    if (hold) await shot(page, 'outer-phone-pinch-half');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  }

  test('closing two fingers goes past the rim, spreading them comes back, and neither zooms the page', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await openOuter(page, { size });
    await pinch(page, 220, 60);
    await expect(heading(page, 'Beyond your universe')).toBeVisible({ timeout: 30_000 });
    await landed(page);
    await expect(friendButtons(page).first()).toBeVisible({ timeout: 30_000 });
    // Closing them again does nothing: it is the farthest there is.
    await pinch(page, 220, 60);
    await page.waitForTimeout(800);
    await expect(heading(page, 'Beyond your universe')).toBeVisible();
    await pinch(page, 60, 220);
    await expect(heading(page, 'Your universe')).toBeVisible({ timeout: 30_000 });
    await landed(page);
    await expect(friendButtons(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1);
  });
});

test.describe('with reduced motion', () => {
  test('there is no flight: the field is there at once, and the arrows still move it', async ({ page }) => {
    test.setTimeout(180_000);
    await openOuter(page, { size: { width: 390, height: 844 }, calm: true });
    await onStage(page);
    await page.keyboard.press('-');
    await expect(heading(page, 'Beyond your universe')).toBeVisible();
    await expect(friendButtons(page).first()).toBeVisible({ timeout: 30_000 });
    // With no loop to draw it, the still frame is drawn again for each move of the field.
    const anchor = (await handlesOf(page))[0]!;
    const at = await boxOf(page.getByTestId(`outer-friend-${anchor}`));
    await page.keyboard.press('ArrowRight');
    await expect
      .poll(async () => (await boxOf(page.getByTestId(`outer-friend-${anchor}`))).x - at.x, { timeout: 10_000 })
      .toBeCloseTo(-60, 0);
    await page.keyboard.press('Escape');
    await expect(heading(page, 'Your universe')).toBeVisible();
    await expect(friendButtons(page)).toHaveCount(0);
  });
});

test.describe('with the switch off', () => {
  test('there is no outer stop: `-` and the wheel do what they did, and no friend is read', async ({ page }) => {
    test.setTimeout(120_000);
    const { roster } = await openOuter(page, { size: { width: 390, height: 844 }, trial: false });
    await page.getByTestId('universe-map').focus();
    await page.keyboard.press('-');
    await page.mouse.move(195, 422);
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(1500);
    await expect(page.getByText('Beyond your universe')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^All friends/ })).toHaveCount(0);
    await expect(page.getByTestId('universe-up')).toHaveCount(0);
    await expect(heading(page, 'Your universe')).toBeVisible();
    expect(roster).toEqual([]);
  });

  test('with it on, a star is entered as ever: the outer stop does not stand in the way of going in', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await openOuter(page, { size: { width: 390, height: 844 } });
    await goOut(page);
    // Back to your universe, then into a star by its name: the flag is not left set under it.
    await page.getByRole('button', { name: 'Back to Your universe', exact: true }).click();
    await landed(page);
    await page.getByRole('button', { name: 'CI system 0, a system', exact: true }).click();
    await expect(heading(page, 'CI system 0')).toBeVisible();
    await landed(page);
    await page.getByRole('button', { name: 'Back to Universe', exact: true }).click();
    await expect(heading(page, 'Your universe')).toBeVisible();
    await expect(page.getByRole('button', { name: /^All friends/ })).toHaveCount(0);
  });
});
