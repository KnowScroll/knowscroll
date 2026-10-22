import { expect, test } from '@playwright/test';

/** Production export over authored HTTP fixtures. No live people, presence or service acceptance. */
const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const scope = { accountId: id(1), privacyEpoch: 1 };
const person = { kind: 'person', personId: id(3), handle: 'fixture.own', displayName: 'Own fixture' };
const peer = {
  kind: 'person',
  personId: id(4),
  handle: 'fixture.peer',
  displayName: 'Authored public name with enough words to test a narrow wrapping button',
};
const envelope = { version: 'sharing.v1', scope };
const token = `ksfi_${'Z'.repeat(43)}`;

test('Friends keeps empty scans explicit, resolves a fragment privately and never auto-requests', async ({ page }) => {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  await page.setViewportSize({ width: 320, height: 690 });
  await page.route('**/auth/session', (route) =>
    route.fulfill({
      json: {
        account: { ...scope, universeId: id(2), email: 'friends@fixture.test' },
        client: 'web',
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
    }),
  );
  await page.route('**/v1/social/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.method() === 'POST' ? (request.postDataJSON() as Record<string, unknown>) : {};
    calls.push({ path, body });
    expect(request.url()).not.toContain(token);
    if (path === '/v1/social/profile')
      return route.fulfill({ json: { ...envelope, status: 'claimed', profileRevision: 1, person } });
    if (path === '/v1/social/invites')
      return route.fulfill({ json: { ...envelope, invite: { status: 'none', inviteRevision: 0 } } });
    if (path.endsWith('/page'))
      return route.fulfill({
        json: {
          version: 'friend-pages.v2',
          requestId: body.requestId,
          scope,
          filter: body.filter,
          snapshotRevision: 1,
          items: body.cursor ? [{ state: 'friends', peer, pairRevision: 1, availability: { state: 'unknown' } }] : [],
          ...(!body.cursor
            ? { next: { scope, filter: body.filter, snapshotRevision: 1, token: 'fixture_scan_cursor' } }
            : {}),
        },
      });
    if (path === '/v1/social/invites/resolve')
      return route.fulfill({ json: { ...envelope, status: 'available', issuer: peer, pairRevision: 0 } });
    return route.fulfill({ status: 500, json: {} });
  });
  await page.goto(`/friends/invite#invite=${token}`);
  await expect(page.getByRole('heading', { name: 'Friend invitation', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/friends\/invite$/);
  await expect(page.getByText('No visible people in this part of the scan. Choose Next to continue.')).toBeVisible();
  expect(calls.filter((c) => c.path.endsWith('/page'))).toHaveLength(1);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.getByText('Friends · availability not shared')).toBeVisible();
  await expect(page.getByText('Online', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Check invitation', exact: true }).click();
  await expect(
    page.getByRole('button', { name: `Request friendship with ${peer.displayName}`, exact: true }),
  ).toBeEnabled();
  expect(calls.some((c) => c.path.endsWith('/friends/request'))).toBe(false);
  expect(calls.filter((c) => c.path.endsWith('/invites/resolve'))[0]?.body).toEqual({ version: 'sharing.v1', token });
  expect(await page.locator('body').textContent()).not.toContain(token);
  expect(await page.evaluate(() => JSON.stringify(window.history.state))).not.toContain(token);
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).some(
        (key) => key.includes('ksfi_') || (localStorage.getItem(key) ?? '').includes('ksfi_'),
      ),
    ),
  ).toBe(false);
  // Keyboard fallback and bounded layout: every actual control remains reachable on a narrow page.
  await page.getByRole('button', { name: 'Back from Friends', exact: true }).focus();
  await expect(page.getByRole('button', { name: 'Back from Friends', exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('button', { name: 'Refresh roster', exact: true })).toBeVisible();
  expect(calls.some((c) => /friends\/(request|accept)|invites\/(create|revoke)$/.test(c.path))).toBe(false);
});

test('signed-out Friends preserves an explicit route back without pretending conversations exist', async ({ page }) => {
  await page.route('**/auth/session', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/problem+json',
      body: JSON.stringify({
        type: 'urn:knowscroll:problem:auth-required',
        title: 'Authentication required',
        status: 401,
        code: 'AUTH_REQUIRED',
      }),
    }),
  );
  await page.goto(`/friends/invite#invite=${token}`);
  await expect(page.getByRole('heading', { name: 'Sign in to manage friends', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/friends\/invite$/);
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toHaveAttribute('href', '/welcome');
  await expect(page.getByRole('button', { name: 'Back from Friends', exact: true })).toBeVisible();
});
