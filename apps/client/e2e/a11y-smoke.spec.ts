import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { fixtureAccount, sceneFixture } from '../features/universe/universe.fixture';
import { emptyInbox, isInboxPath } from './empty-inbox';
import { encounterFixture, id } from './encounter-fixture';

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
async function seriousViolations(page: Page): Promise<Violation[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({
      rule: violation.id,
      impact: violation.impact ?? '',
      help: violation.help,
      targets: violation.nodes.slice(0, 4).map((node) => `${node.target.join(' ')}  ${node.html.slice(0, 140)}`),
    }));
}

/**
 * Waits until the route has painted its own content, then checks it: one main landmark (V01), and
 * no serious axe violation.
 */
async function expectAccessible(page: Page, ready: () => Promise<void>, landmarks = true) {
  await ready();
  // A skeleton or a spinner is not the screen: wait until the route has finished loading.
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  // Behind a modal sheet the page is inert, so its landmarks are hidden on purpose.
  if (landmarks) await expect(page.getByRole('main')).toHaveCount(1);
  expect(await seriousViolations(page)).toEqual([]);
}

const account = { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'axe@fixture.test' };

/** A signed-in account with an empty Talk inbox, nothing kept and no sessions beyond this one. */
async function signedInAccount(page: Page) {
  const ago = new Date(Date.now() - 60_000).toISOString();
  await page.route('**/auth/session', (route) =>
    route.fulfill({ json: { account, client: 'web', expiresAt: '2099-10-23T00:00:00.000Z' } }),
  );
  await page.route('**/auth/deletion/**', (route) => route.fulfill({ json: { state: 'in_progress' } }));
  await page.route('**/v1/**', (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
    const scope = { accountId: account.accountId, privacyEpoch: 1 };
    if (isInboxPath(path)) return route.fulfill({ json: emptyInbox(path, body, account.accountId) });
    if (path === '/v1/privacy/recording/read')
      return route.fulfill({
        json: { version: 'recording-policy.v1', ...body, scope, revision: 0, policy: { on: true, generation: 1 } },
      });
    if (path === '/v1/privacy/clear-exploration/status')
      return route.fulfill({
        json: { version: 'clear-exploration.v1', scope, target: body['target'], status: 'not_recorded' },
      });
    if (path === '/v1/account/sessions')
      return route.fulfill({
        json: {
          sessions: [
            {
              id: id(10),
              client: 'web',
              deviceLabel: 'Chrome on macOS',
              lastUsedAt: ago,
              signedInAt: ago,
              current: true,
            },
          ],
        },
      });
    if (path === '/v1/saved')
      return route.fulfill({
        json: {
          pagination: 'saved-page.v1',
          consistency: 'live',
          filter: new URL(request.url()).searchParams.get('filter'),
          limit: 20,
          scope,
          continuation: { status: 'end' },
          revision: 1,
          items: [],
        },
      });
    return route.fulfill({ status: 404, json: {} });
  });
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
  test('the More sheet over a Reel has no serious axe violations', async ({ page }) => {
    await encounterFixture(page, 'reel', { viewport: { width: 390, height: 844 }, series: true });
    await page.route('**/media/gesture-fixture', (route) => route.fulfill({ status: 404, body: 'fixture only' }));
    await page.goto('/explore');
    await page.getByRole('button', { name: 'Got it' }).click();
    await page.getByRole('button', { name: 'More options' }).click();
    await expectAccessible(
      page,
      () => expect(page.getByRole('heading', { name: 'More', exact: true })).toBeVisible(),
      false,
    );
  });
});

test.describe('the Universe', () => {
  /** The authored scene of the Universe smoke: a map of systems, each with planets and regions. */
  async function openUniverse(page: Page, size: (typeof widths)[number]) {
    const world = sceneFixture();
    await page.setViewportSize({ width: size.width, height: size.height });
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
      // From 1024 px the outline is always open beside the map; below it, it is a sheet.
      if (size.width < 1024) {
        await page.getByRole('button', { name: 'List view', exact: true }).click();
        await expectAccessible(
          page,
          () => expect(page.getByRole('heading', { name: 'Your universe' })).toBeVisible(),
          false,
        );
      }
    });
  }
});
