import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import { signedInAccount } from './account-fixture';
import { encounterFixture } from './encounter-fixture';
import { roomFixture } from './rooms-fixture';
import { openPair, pairWorld } from './talk-pair-fixture';
import { openParty } from './thread-party-fixture';
import { whatIfWorld } from './thread-whatif-fixture';

/**
 * Appearance (#666) in the production export over labelled HTTP fixtures (no backend): Light or Dark is found from
 * Account, applies to the whole page at once, survives a reload, carries an earlier Talk choice (D-151) over, and reads
 * cleanly in a conversation, a thread, a room and the Scroll reader in both. Screenshots are written only when
 * `KS_APPEARANCE_SHOTS` names a folder (for the PR; never inside the repository).
 */
const phone = { width: 390, height: 844 };
const desktop = { width: 1440, height: 900 };
const KEY = 'ks.device.preferences';
const SKY = 'rgb(2, 3, 8)';
const PAPER = 'rgb(255, 251, 240)';

async function shot(page: Page, name: string) {
  const folder = process.env['KS_APPEARANCE_SHOTS'];
  if (folder === undefined) return;
  mkdirSync(folder, { recursive: true });
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(folder, `${name}.png`) });
}

async function seriousViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({
      rule: violation.id,
      targets: violation.nodes
        .slice(0, 4)
        .map(
          (node) => `${node.target.join(' ')} ${node.html.slice(0, 140)} ${node.failureSummary?.slice(0, 160) ?? ''}`,
        ),
    }));
}

/** What this device has kept, before the app reads it (an install from before #666, or a fresh one). */
async function kept(page: Page, preferences: Record<string, unknown> | undefined) {
  if (preferences === undefined) return;
  await page.addInitScript(
    ([key, value]) => {
      // Only on the first load, so a reload reads what the app itself wrote.
      if (window.sessionStorage.getItem('ks-e2e-seeded') === null) {
        window.localStorage.setItem(key, value);
        window.sessionStorage.setItem('ks-e2e-seeded', '1');
      }
    },
    [KEY, JSON.stringify(preferences)] as const,
  );
}

const appearanceOf = (page: Page) => page.evaluate(() => document.documentElement.getAttribute('data-ks-appearance'));
const stored = (page: Page) =>
  page.evaluate((key) => JSON.parse(window.localStorage.getItem(key) ?? 'null') as Record<string, unknown> | null, KEY);
const pageGround = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test('Appearance is found from Account, applies to the whole page at once and survives a reload', async ({ page }) => {
  await signedInAccount(page);
  await page.setViewportSize(phone);
  await page.goto('/account');
  // A fresh install is Dark.
  await expect.poll(() => appearanceOf(page)).toBe('dark');
  await expect.poll(() => pageGround(page)).toBe(SKY);
  const row = page.getByRole('link', { name: 'Appearance' });
  await expect(row).toContainText('Light or dark · Dark');
  await shot(page, 'account-phone-dark');
  await row.click();
  await expect(page).toHaveURL(/\/account\/appearance$/);
  await expect(page.getByRole('radio', { name: 'Dark' })).toBeChecked();
  await shot(page, 'appearance-phone-dark');

  await page.getByRole('radio', { name: 'Light' }).click();
  await expect(page.getByRole('radio', { name: 'Light' })).toBeChecked();
  // At once: the page's own ground changes with no navigation.
  await expect.poll(() => appearanceOf(page)).toBe('light');
  await expect.poll(() => pageGround(page)).toBe(PAPER);
  expect(await stored(page)).toMatchObject({ appearance: 'light' });
  expect(await stored(page)).not.toHaveProperty('talkTheme');
  await shot(page, 'appearance-phone-light');

  await page.reload();
  await expect(page.getByRole('radio', { name: 'Light' })).toBeChecked();
  await expect.poll(() => appearanceOf(page)).toBe('light');
  expect(await seriousViolations(page)).toEqual([]);

  // By keyboard: the ring is cobalt on Light; choosing Dark turns it yellow on the sky, at once.
  await page.getByRole('radio', { name: 'Light' }).click();
  await page.keyboard.press('Tab');
  const dark = page.getByRole('radio', { name: 'Dark' });
  await expect(dark).toBeFocused();
  await expect(dark).toHaveCSS('outline-color', 'rgb(44, 70, 232)');
  await page.keyboard.press('Enter');
  await expect(dark).toBeChecked();
  await expect.poll(() => appearanceOf(page)).toBe('dark');
  await expect(dark).toHaveCSS('outline-color', 'rgb(255, 228, 77)');
  expect(await seriousViolations(page)).toEqual([]);
  await shot(page, 'appearance-phone-dark-focus');
});

for (const [earlier, appearance] of [
  ['paper', 'light'],
  ['sky', 'dark'],
] as const)
  test(`an earlier Talk choice of ${earlier} opens as ${appearance} and leaves one theme preference`, async ({
    page,
  }) => {
    await kept(page, {
      motion: 'reduce',
      textSize: 'larger',
      reelSound: false,
      readyNotices: true,
      talkTheme: earlier,
    });
    await signedInAccount(page);
    await page.setViewportSize(desktop);
    await page.goto('/account/appearance');
    await expect(page.getByRole('radio', { name: appearance === 'light' ? 'Light' : 'Dark' })).toBeChecked();
    expect(await appearanceOf(page)).toBe(appearance);
    // Rewritten once in today's shape: the other choices are kept and no Talk-only theme is left behind.
    await expect
      .poll(() => stored(page))
      .toEqual({ motion: 'reduce', textSize: 'larger', reelSound: false, readyNotices: true, appearance });
    await page.reload();
    await expect.poll(() => appearanceOf(page)).toBe(appearance);
  });

for (const viewport of [phone, desktop])
  for (const appearance of ['dark', 'light'] as const) {
    const size = viewport === phone ? 'phone' : 'desktop';

    test(`Appearance and Settings read cleanly in ${appearance} at ${size}`, async ({ page }) => {
      await kept(page, { appearance });
      await signedInAccount(page);
      await page.setViewportSize(viewport);
      await page.goto('/account/appearance');
      await expect(page.getByRole('radio', { name: appearance === 'light' ? 'Light' : 'Dark' })).toBeChecked();
      expect(await seriousViolations(page)).toEqual([]);
      await shot(page, `appearance-${size}-${appearance}`);
      await page.goto('/account/accessibility');
      await page.getByRole('radio', { name: 'Largest' }).click();
      await expect(page.getByRole('radio', { name: 'Largest' })).toBeChecked();
      expect(await seriousViolations(page)).toEqual([]);
      await shot(page, `accessibility-largest-${size}-${appearance}`);
    });

    test(`a conversation follows ${appearance} at ${size}`, async ({ page }) => {
      await kept(page, { appearance });
      const world = pairWorld();
      world.say('ravi', 'part 1 dekha?', { minutesAgo: 30 });
      world.say('asha', 'haan, moon ka bulge samajh aaya', { minutesAgo: 20 });
      await openPair(page, world, 'asha', viewport);
      await expect(page.getByTestId('conversation-messages')).toHaveCSS(
        'background-color',
        appearance === 'dark' ? SKY : 'rgb(244, 237, 216)',
      );
      expect(await seriousViolations(page)).toEqual([]);
      await shot(page, `conversation-${size}-${appearance}`);
    });

    test(`a thread follows ${appearance} at ${size}`, async ({ page }) => {
      await kept(page, { appearance });
      const world = whatIfWorld();
      await openParty(page, world, 'asha', viewport);
      await expect(page.getByRole('heading', { level: 1, name: 'CI series' })).toBeVisible();
      expect(await seriousViolations(page)).toEqual([]);
      await shot(page, `thread-${size}-${appearance}`);
    });

    test(`a room follows ${appearance} at ${size}`, async ({ page }) => {
      await kept(page, { appearance });
      const { address } = await roomFixture(page, viewport, { others: 2, lastMessageMinutesAgo: 30, noticeSeen: true });
      await page.goto(address);
      await expect(page.getByRole('textbox', { name: 'Message General' })).toBeVisible();
      expect(await seriousViolations(page)).toEqual([]);
      await shot(page, `room-${size}-${appearance}`);
    });

    test(`the Scroll reader follows ${appearance} at ${size}`, async ({ page }) => {
      await kept(page, { appearance });
      await encounterFixture(page, 'scroll', {
        series: true,
        viewport,
        scrollDocument: seasons as unknown as Record<string, unknown>,
      });
      await page.goto('/explore');
      await expect(page.getByRole('heading', { level: 1, name: 'CI encounter fixture 1' })).toBeVisible();
      await page.getByRole('button', { name: 'Got it' }).click();
      expect(await seriousViolations(page)).toEqual([]);
      await shot(page, `reader-${size}-${appearance}`);
    });
  }

test('switching halfway through a Scroll keeps the reader’s place and the play already made', async ({ page }) => {
  await kept(page, { appearance: 'dark' });
  const served = await encounterFixture(page, 'scroll', {
    series: true,
    viewport: desktop,
    scrollDocument: seasons as unknown as Record<string, unknown>,
  });
  await page.goto('/explore');
  await expect(page.getByRole('heading', { level: 1, name: 'CI encounter fixture 1' })).toBeVisible();
  await page.getByRole('button', { name: 'Got it' }).click();
  // Halfway: on the first Call it, with a pick locked in and a spark in the dock.
  await page.getByRole('button', { name: 'Call it 1 of 3', exact: true }).click();
  await page.getByRole('radio', { name: /Delhi’s half/ }).click();
  await page.getByRole('group', { name: 'Call it 1 of 3' }).getByRole('button', { name: 'Lock it in' }).click();
  await expect(page.getByText('Called it!')).toBeVisible();
  await expect(page.getByTestId('spark-chip')).toHaveAttribute('aria-label', '1 spark');
  const here = page.getByRole('button', { name: 'Call it 1 of 3, you are here' });
  await expect(here).toBeVisible();
  await shot(page, 'reader-switch-before-dark');
  const commandsBefore = served.commands.length;

  // To Appearance the way a person goes, and back.
  await page.getByRole('link', { name: 'Account and settings' }).click();
  await page.getByRole('link', { name: 'Appearance' }).click();
  await page.getByRole('radio', { name: 'Light' }).click();
  await expect.poll(() => appearanceOf(page)).toBe('light');
  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL(/\/explore$/);

  await expect(here).toBeVisible();
  await expect(page.getByText('Called it!')).toBeVisible();
  await expect(page.getByTestId('spark-chip')).toHaveAttribute('aria-label', '1 spark');
  expect(await appearanceOf(page)).toBe('light');
  // Nothing about the encounter was done again: no new open, activation, navigation or lock (a read may refresh).
  const after = served.commands.slice(commandsBefore).map((command) => command.path);
  expect(after.filter((path) => /\/(encounter|experience|play)\//.test(path) && !path.endsWith('/read'))).toEqual([]);
  expect(await seriousViolations(page)).toEqual([]);
  await shot(page, 'reader-switch-after-light');
});
