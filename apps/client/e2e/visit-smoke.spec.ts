import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { fixtureAccount, fixtureId } from '../features/universe/universe.fixture';
import { emptyInbox, isInboxPath } from './empty-inbox';

/**
 * A friend's universe (U06) in the production export, over an authored HTTP fixture (the friend and their
 * systems are made up for CI): one cream bar with Leave first, the options behind the friend's initial, the one
 * lock chip at the bottom, and the primary navigation kept with Universe current, at a phone and a desktop width.
 */
const shots = process.env['KS_SHOT_DIR'];

const visitAnswer = (body: Record<string, unknown>) => ({
  version: 'sharing.v1',
  scope: { accountId: fixtureAccount.accountId, privacyEpoch: 1 },
  target: body['target'],
  capabilities: body['capabilities'],
  status: 'available',
  owner: { kind: 'person', personId: fixtureId(11), handle: 'fixture.ravi', displayName: 'Ravi fixture' },
  authority: { pairRevision: 3, publishedProjectionRevision: 1 },
  projection: {
    presentation: 'list.v1',
    systems: [
      {
        publicSystemId: fixtureId(200),
        label: 'Machine learning',
        planets: [{ publicPlanetId: fixtureId(201), label: 'Inference' }],
      },
      {
        publicSystemId: fixtureId(210),
        label: 'Baking',
        planets: [{ publicPlanetId: fixtureId(211), label: 'Bread' }],
      },
    ],
  },
});

async function openVisit(page: Page, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  await page.emulateMedia({ reducedMotion: 'reduce' });
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
    if (path === '/v1/social/visits/read') return route.fulfill({ json: visitAnswer(body) });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto('/visit/fixture.ravi');
  await expect(page.getByTestId('visitor-bar')).toBeVisible({ timeout: 60_000 });
}

async function expectNoSeriousViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  const serious = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  expect(
    serious.map((violation) => ({ rule: violation.id, nodes: violation.nodes.map((node) => node.target.join(' ')) })),
  ).toEqual([]);
}

test('a phone: one bar with Leave first, the options behind the initial, one lock chip, and the tab bar kept', async ({
  page,
}) => {
  await openVisit(page, { width: 390, height: 844 });
  const bar = page.getByTestId('visitor-bar');
  await expect(bar).toContainText('Visiting Ravi fixture’s universe');
  await expect(bar).toContainText('Only what Ravi fixture shares');
  // Leave comes before the initial, to the eye and in the tab order.
  const leave = page.getByTestId('visit-leave');
  const initial = page.getByTestId('visit-options');
  expect((await leave.boundingBox())!.x).toBeLessThan((await initial.boundingBox())!.x);
  await leave.focus();
  await page.keyboard.press('Tab');
  await expect(initial).toBeFocused();
  // Report is not on the map until the options are opened.
  await expect(page.getByRole('button', { name: /^Report/ })).toHaveCount(0);
  await initial.click();
  await expect(page.getByRole('button', { name: 'Report Ravi fixture' })).toBeVisible();
  await initial.click();
  // The primary navigation stays, with Universe current.
  await expect(page.getByRole('link', { name: 'Universe', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('link', { name: 'Explore', exact: true })).toBeVisible();
  await expect(page.getByTestId('visit-private-parts')).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/visit-phone.png` });
  await expectNoSeriousViolations(page);
});

test('a desktop: the rail is kept with Universe current', async ({ page }) => {
  await openVisit(page, { width: 1440, height: 900 });
  await expect(page.getByRole('link', { name: 'Universe', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('link', { name: 'Keep', exact: true })).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/visit-desktop.png` });
  await expectNoSeriousViolations(page);
});
