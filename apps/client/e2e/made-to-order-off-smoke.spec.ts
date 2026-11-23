import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import v2 from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import v3 from '@knowscroll/scroll-model/fixtures/seasons-v3-ci.json';
import { encounterFixture, id, readCover } from './encounter-fixture';
import { openParty } from './thread-party-fixture';
import { whatIfWorld } from './thread-whatif-fixture';

/**
 * The Scrolls made to order switched off (D-436, #784), in the production export over labelled HTTP fixtures (no backend):
 * `GET /v1/account/features` says `madeToOrder: false`, and "You asked", "What if" and "Another perspective" have no way in.
 * A v2 Scroll and a document v3 Scroll, in Explore and on their own address, show no Ask row in the ••• sheet, answer neither the
 * A key nor the ? key, and send nothing to `/v1/content/requests`; a thread that has branches already (the fixture keeps them, as
 * the server would) shows none of them, no What if / Another perspective buttons, no message-menu rows and no Map, reads no
 * branches, and a branch's address is the app's not-found page. Every other row and control stays. Both viewports are
 * scanned with axe, as the other specs do. Screenshots are written only when `KS_OFF_SHOTS` names a folder (outside the repository).
 * The same screens with the switch on are in `ask-smoke.spec.ts`, `folio-reader-smoke.spec.ts` and `thread-whatif-smoke.spec.ts`.
 */
const phone = { width: 390, height: 844 };
const desktop = { width: 1440, height: 900 };
const viewports = [
  { label: '390 x 844', size: phone, shot: '390' },
  { label: '1440 x 900', size: desktop, shot: '1440' },
] as const;

async function shot(page: Page, name: string) {
  const folder = process.env['KS_OFF_SHOTS'];
  if (folder === undefined) return;
  mkdirSync(folder, { recursive: true });
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(folder, `${name}.png`) });
}

async function audit(page: Page) {
  // A cover draws its picture in and a sheet rises; both are measured once they have stopped.
  await page.waitForTimeout(700);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(' | ')}`);
}

const documents = [
  { name: 'v2', document: v2 as unknown as Record<string, unknown>, suggestions: v2.askSuggestions },
  { name: 'document v3', document: v3 as unknown as Record<string, unknown>, suggestions: v3.askSuggestions },
] as const;

const reader = (page: Page) => page.getByRole('group', { name: 'Scroll reader' });
const askDialog = (page: Page) => page.getByRole('dialog', { name: 'Ask for something' });

/** Nothing of "You asked" is on the screen or in the ••• sheet, and the keys that opened Ask open nothing. */
async function expectNoWayIn(
  page: Page,
  served: Awaited<ReturnType<typeof encounterFixture>>,
  suggestions: readonly string[],
) {
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const more = page.getByRole('dialog', { name: 'More' });
  await expect(more).toBeVisible();
  const titles = await page
    .getByTestId('more-list')
    .getByRole('listitem')
    .getByRole('button')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')));
  // The rows that are not made to order stay, in their order, with nothing where Ask was.
  expect(titles).not.toContain('Ask about this');
  expect(titles).toContain('Simpler (this screen)');
  expect(titles).toContain('Report');
  await expect(page.getByTestId('more-ask')).toHaveCount(0);
  await expect(more.getByRole('button', { name: 'Ask about this' })).toHaveCount(0);
  // No orphan gap or divider where the row was: the first row is the next one, directly under the sheet's heading.
  await expect(page.getByTestId('more-list').getByRole('listitem').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(more).toHaveCount(0);
  for (const key of ['a', '?']) {
    await reader(page).focus();
    await page.keyboard.press(key);
    await expect(askDialog(page)).toHaveCount(0);
  }
  for (const suggestion of suggestions) await expect(page.getByText(suggestion, { exact: true })).toHaveCount(0);
  expect(served.commands.filter((command) => command.path === '/v1/content/requests')).toEqual([]);
}

for (const { name, document, suggestions } of documents)
  for (const { label, size, shot: tag } of viewports) {
    test(`a ${name} Scroll in Explore has no way into a Scroll made to order, at ${label}`, async ({ page }) => {
      const served = await encounterFixture(page, 'scroll', {
        series: true,
        viewport: size,
        scrollDocument: document,
        madeToOrder: false,
      });
      const asked = page.waitForRequest((request) => new URL(request.url()).pathname === '/v1/account/features');
      await page.goto('/explore');
      await asked;
      await readCover(page);
      await expect(
        page.getByTestId('reader-top-title').getByRole('heading', { level: 1, name: 'CI encounter fixture 1' }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Got it' }).click();
      await shot(page, `reader-${name.replace(' ', '-')}-${tag}`);
      expect(await audit(page)).toEqual([]);
      await expectNoWayIn(page, served, suggestions);
      expect(await audit(page)).toEqual([]);
    });

    test(`a ${name} Scroll on its own address has no way into a Scroll made to order, at ${label}`, async ({
      page,
    }) => {
      const served = await encounterFixture(page, 'scroll', {
        viewport: size,
        direct: { parts: 1 },
        scrollDocument: document,
        madeToOrder: false,
      });
      await page.goto(`/scroll/${id(300)}`);
      await expect(page.getByTestId('scroll-reader')).toBeVisible();
      await expect(page.getByTestId('folio-scroller')).toBeVisible();
      await expectNoWayIn(page, served, suggestions);
    });
  }

for (const { label, size, shot: tag } of viewports)
  test(`a thread that has branches shows none, reads none and offers none, at ${label}`, async ({ browser }) => {
    const world = whatIfWorld({ madeToOrder: false });
    // Two branches the thread made while the switch was on: the server still has them, the app no longer shows them.
    world.seedToday(2);
    const context = await browser.newContext({ viewport: size });
    const page = await context.newPage();
    await openParty(page, world, 'asha', size);
    await expect(page.getByRole('heading', { level: 1, name: 'CI series' })).toBeVisible();
    // The app asked the API whether the switch is on, and only then decided.
    await expect.poll(() => world.requests.some((request) => request.path === '/v1/account/features')).toBe(true);

    await expect(page.getByTestId('ask-what-if')).toHaveCount(0);
    await expect(page.getByTestId('ask-perspective')).toHaveCount(0);
    await expect(page.getByLabel('Explore other possibilities')).toHaveCount(0);
    await expect(page.getByTestId('what-if-card')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'What if…' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Another perspective' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Map/ })).toHaveCount(0);
    await expect(page.getByTestId('scenario-sheet')).toHaveCount(0);
    // The message box and the rest of the thread stay.
    await expect(page.getByRole('textbox')).toBeVisible();
    await shot(page, `thread-${tag}`);
    expect(await audit(page)).toEqual([]);

    // A message's menu keeps its own rows and has none of What if / Another perspective.
    const options = page.getByRole('button', { name: /^Options for/ }).first();
    await options.focus();
    await options.click();
    await expect(page.getByTestId('menu-copy').or(page.getByTestId('menu-reply')).first()).toBeVisible();
    await expect(page.getByTestId('menu-what-if')).toHaveCount(0);
    await expect(page.getByTestId('menu-perspective')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // No branch was read for it, so none was drawn and none could flash on and off.
    expect(world.requests.filter((request) => request.path.startsWith('/v1/social/scenarios/'))).toEqual([]);

    // A branch's own address is an address that is not a screen.
    const url = new URL(page.url());
    await page.goto(`${url.pathname}/b/${world.nodes[0]!.nodeId}${url.search}`);
    await expect(page.getByText("This page isn't here")).toBeVisible();
    await expect(page.getByRole('link', { name: 'Go to Explore' })).toBeVisible();
    expect(await audit(page)).toEqual([]);
    await context.close();
  });
