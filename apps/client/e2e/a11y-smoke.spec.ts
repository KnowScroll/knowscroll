import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { fixtureAccount, sceneFixture } from '../features/universe/universe.fixture';
import { conversation, talkFixture, thread } from './talk-fixture';
import { emptyInbox, isInboxPath } from './empty-inbox';
import { signedInAccount } from './account-fixture';
import { encounterFixture } from './encounter-fixture';

/**
 * Automated accessibility checks (axe-core) over the main routes of the production export, at a
 * phone, a tablet and a desktop width, signed out and signed in with authored HTTP fixtures.
 * Serious and critical violations fail the run; nothing is baselined or ignored. Axe covers what a
 * machine can see (names, roles, contrast, landmarks); the keyboard walkthrough in
 * `keyboard-smoke.spec.ts` and the screen-reader notes in the PR cover the rest.
 */

const widths = [
  { width: 390, height: 844, label: 'phone' },
  { width: 834, height: 1112, label: 'tablet' },
  { width: 1440, height: 900, label: 'desktop' },
] as const;

interface Violation {
  readonly rule: string;
  readonly impact: string;
  readonly help: string;
  readonly targets: readonly string[];
}

/** Serious and critical WCAG 2.x A/AA violations on the page as it is now, in a readable shape. */
async function seriousViolations(page: Page, within?: string): Promise<Violation[]> {
  const builder = new AxeBuilder({ page });
  if (within !== undefined) builder.include(within);
  const results = await builder
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({
      rule: violation.id,
      impact: violation.impact ?? '',
      help: violation.help,
      targets: violation.nodes
        .slice(0, 4)
        .map(
          (node) =>
            `${node.target.join(' ')}  ${node.html.slice(0, 100)}  ${JSON.stringify(node.any[0]?.data ?? {}).slice(0, 200)}`,
        ),
    }));
}

/** Waits until a sheet has finished fading in: axe would read half-transparent text as low contrast. */
async function sheetSettled(page: Page) {
  const total = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[role="dialog"], [role="dialog"] *')].reduce(
        (sum, node) => sum + Number.parseFloat(getComputedStyle(node).opacity),
        0,
      ),
    );
  let last = -1;
  await expect
    .poll(async () => {
      const now = await total();
      const settled = now === last;
      last = now;
      await page.waitForTimeout(120);
      return settled;
    })
    .toBe(true);
}

/**
 * Waits until the route has painted its own content, then checks it: one main landmark (V01), and
 * no serious axe violation.
 */
async function expectAccessible(page: Page, ready: () => Promise<void>, insideDialog = false) {
  await ready();
  // A skeleton or a spinner is not the screen: wait until the route has finished loading.
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  // Behind a modal dialog the page is out of reach (no landmarks to count, no contrast to ask of
  // text under the scrim), so an open dialog is checked on its own.
  if (insideDialog) await sheetSettled(page);
  else await expect(page.getByRole('main')).toHaveCount(1);
  expect(await seriousViolations(page, insideDialog ? '[role="dialog"]' : undefined)).toEqual([]);
}

test.describe('signed out', () => {
  const routes = [
    { path: '/explore', ready: 'Welcome' },
    { path: '/welcome', ready: 'Welcome' },
    { path: '/signin', ready: 'Sign in' },
    { path: '/recover', ready: 'You were signed out' },
    { path: '/nowhere', ready: "This page isn't here" },
  ] as const;
  for (const size of widths) {
    for (const route of routes) {
      test(`${route.path} at ${size.label} has no serious axe violations`, async ({ page }) => {
        await page.route('**/auth/session', (call) =>
          call.fulfill({
            status: 401,
            contentType: 'application/problem+json',
            json: { code: 'AUTH_REQUIRED', status: 401, title: 'Authentication required', type: 'tag:x' },
          }),
        );
        await page.setViewportSize({ width: size.width, height: size.height });
        await page.goto(route.path);
        await expectAccessible(page, () => expect(page.getByRole('main')).toBeVisible());
      });
    }
  }
});

test.describe('signed in', () => {
  const routes = [
    { path: '/conversations', name: 'Talk' },
    { path: '/saved', name: 'Keep' },
    { path: '/account', name: 'Account' },
    { path: '/account/notifications', name: 'Notifications' },
    { path: '/account/accessibility', name: 'Accessibility and playback' },
    { path: '/account/privacy', name: 'Privacy' },
    { path: '/account/privacy/clear', name: 'Clear exploration' },
    { path: '/account/privacy/delete', name: 'Delete account' },
    { path: '/account/privacy/export', name: 'History and export' },
    { path: '/friends', name: 'Friends' },
  ] as const;
  for (const size of widths) {
    for (const route of routes) {
      test(`${route.name} at ${size.label} has no serious axe violations`, async ({ page }) => {
        await signedInAccount(page);
        await page.setViewportSize({ width: size.width, height: size.height });
        await page.goto(route.path);
        await expectAccessible(page, () => expect(page.getByRole('main')).toBeVisible());
      });
    }
  }
});

test.describe('an encounter', () => {
  for (const size of widths) {
    for (const kind of ['reel', 'scroll'] as const) {
      test(`a ${kind} in Explore at ${size.label} has no serious axe violations`, async ({ page }) => {
        await encounterFixture(page, kind, { viewport: size, series: true });
        await page.route('**/media/gesture-fixture', (route) =>
          route.fulfill({ status: 404, body: 'CI gesture fixture only' }),
        );
        await page.goto('/explore');
        await expectAccessible(page, () =>
          expect(page.getByTestId(kind === 'reel' ? 'encounter-reel-caption' : 'encounter-page')).toContainText(
            'CI encounter fixture 1',
          ),
        );
      });
    }
  }
});

test.describe('a sheet', () => {
  /** What each sheet names itself, and the control that opens it from a Reel with its thread. */
  const sheets = [
    { name: 'More', open: (page: Page) => page.getByRole('button', { name: 'More options' }) },
    { name: 'Share', open: (page: Page) => page.getByRole('button', { name: 'Share', exact: true }) },
    { name: 'Ask', open: (page: Page) => page.getByRole('button', { name: 'Ask about this' }) },
  ] as const;
  for (const size of [widths[0], widths[2]]) {
    for (const sheet of sheets) {
      test(`the ${sheet.name} sheet over a Reel at ${size.label} has no serious axe violations`, async ({ page }) => {
        await encounterFixture(page, 'reel', { viewport: size, series: true });
        await page.route('**/media/gesture-fixture', (route) => route.fulfill({ status: 404, body: 'fixture only' }));
        await page.goto('/explore');
        // The swipe hint is drawn only where the Reel is full-bleed.
        if (size.width < 1024) await page.getByRole('button', { name: 'Got it' }).click();
        await sheet.open(page).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await expectAccessible(page, () => expect(page.getByRole('dialog')).toBeVisible(), true);
      });
    }
  }
});

test.describe('the keyboard map', () => {
  test('over a desktop Explore has no serious axe violations', async ({ page }) => {
    await encounterFixture(page, 'reel', { viewport: widths[2], series: true });
    await page.route('**/media/gesture-fixture', (route) => route.fulfill({ status: 404, body: 'fixture only' }));
    await page.goto('/explore');
    await page.getByRole('button', { name: 'All shortcuts' }).click();
    await expectAccessible(
      page,
      () => expect(page.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible(),
      true,
    );
  });

  for (const size of [widths[0], widths[2]]) {
    test(`from Account at ${size.label} has no serious axe violations`, async ({ page }) => {
      await signedInAccount(page);
      await page.setViewportSize(size);
      await page.goto('/account');
      await page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
      // The page behind a modal sheet is out of reach while it is open, and back when it closes.
      await expect(page.locator('#root')).toHaveAttribute('inert', '');
      await expectAccessible(
        page,
        () => expect(page.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible(),
        true,
      );
      await page.keyboard.press('Escape');
      await expect(page.locator('#root')).not.toHaveAttribute('inert');
    });
  }
});

test.describe('the Universe', () => {
  /** The authored scene of the Universe smoke: a map of systems, each with planets and regions. */
  async function openUniverse(page: Page, size: (typeof widths)[number]) {
    const world = sceneFixture();
    await page.setViewportSize({ width: size.width, height: size.height });
    // These checks walk the map; its animations have axe checks of their own (universe-animations-smoke.spec.ts).
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.route('**/auth/session', (route) =>
      route.fulfill({ json: { account: fixtureAccount, client: 'web', expiresAt: '2099-10-21T00:00:00.000Z' } }),
    );
    await page.route('**/v1/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
      const scope = { universeId: fixtureAccount.universeId, privacyEpoch: 1, personalWatermark: 40 };
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
            scope,
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
    await expect(page.getByRole('button', { name: 'CI system 0, a system', exact: true })).toBeVisible();
  }

  for (const size of widths) {
    test(`the map and a system at ${size.label} have no serious axe violations`, async ({ page }) => {
      await openUniverse(page, size);
      await expectAccessible(page, () => expect(page.getByRole('main')).toBeVisible());
      await page.getByRole('button', { name: 'CI system 0, a system', exact: true }).click();
      await expectAccessible(page, () =>
        expect(page.getByRole('heading', { level: 1, name: 'CI system 0', exact: true })).toBeVisible(),
      );
      // From 1024 px the panel is always open beside the map; below it, the orbit dial replaces the List view.
      if (size.width < 1024) {
        await page.getByRole('button', { name: 'Back to Universe', exact: true }).click();
        await page.getByRole('button', { name: 'List view', exact: true }).click();
        await expectAccessible(page, () => expect(page.getByTestId('universe-dial')).toBeVisible());
        await page.getByTestId('dial-system-pill').click();
        await expectAccessible(page, () => expect(page.getByTestId('dial-system-facts')).toBeVisible());
      }
    });

    test(`the Simple view at ${size.label} has no serious axe violations`, async ({ page }) => {
      await openUniverse(page, size);
      if (size.width < 1024) {
        await page.getByRole('button', { name: 'List view', exact: true }).click();
        await page.getByRole('button', { name: 'Simple view', exact: true }).click();
      } else await page.getByRole('switch', { name: 'Simple drawing', exact: true }).click();
      await expectAccessible(page, () => expect(page.getByTestId('universe-simple')).toBeVisible());
      await page
        .getByRole('button', { name: /CI planet 2, a planet/ })
        .first()
        .click();
      await expectAccessible(page, () =>
        expect(page.getByRole('heading', { level: 1, name: 'CI planet 2', exact: true })).toBeVisible(),
      );
    });
  }
});

test.describe('Talk with something in it', () => {
  const addresses = [
    { name: 'the inbox', path: '/conversations', ready: 'Ravi fixture' },
    {
      name: 'a conversation',
      path: `/conversations/${conversation.conversationId}?m=${conversation.membershipId}&r=1`,
      ready: 'Starting the second part now.',
    },
    { name: 'a content thread', path: `/threads/${thread.threadId}?m=${thread.membershipId}&r=1`, ready: 'CI series' },
  ] as const;
  for (const size of widths) {
    for (const address of addresses) {
      test(`${address.name} at ${size.label} has no serious axe violations`, async ({ page }) => {
        await talkFixture(page, size);
        await page.goto(address.path);
        await expectAccessible(page, () => expect(page.getByText(address.ready).first()).toBeVisible());
      });
    }
  }
  test('the Series sheet of a content thread at phone has no serious axe violations', async ({ page }) => {
    await talkFixture(page, widths[0]);
    await page.goto(`/threads/${thread.threadId}?m=${thread.membershipId}&r=1`);
    await page.getByTestId('thread-series-button').click();
    await expectAccessible(page, () => expect(page.getByRole('dialog')).toBeVisible(), true);
  });
  test('a content thread at phone with its player open has no serious axe violations', async ({ page }) => {
    await talkFixture(page, widths[0]);
    await page.goto(`/threads/${thread.threadId}?m=${thread.membershipId}&r=1`);
    await page.getByRole('button', { name: /^Open Part 1 of 3/ }).click();
    await expectAccessible(page, () => expect(page.getByRole('button', { name: 'Watch', exact: true })).toBeVisible());
  });
});
