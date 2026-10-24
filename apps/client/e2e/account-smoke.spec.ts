import { expect, test, type Page } from '@playwright/test';

/**
 * The production export with authored HTTP fixtures (no real backend): sessions in Account,
 * export through a one-time download, and account deletion with its receipt, at a phone and at a
 * desktop width (P01, P02, D05). Not a claim about a real account, worker or device.
 */
const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const scope = { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'account@fixture.test' };

interface Fixture {
  sessions: { id: string; client: string; deviceLabel: string; lastUsedAt: string; current: boolean }[];
  exports: { id: string; state: string; requestedAt: string; expiresAt: string | null }[];
  deletion: 'in_progress' | 'completed';
  deleted: boolean;
  requests: { path: string; body: unknown }[];
}

async function mount(page: Page): Promise<Fixture> {
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const fixture: Fixture = {
    sessions: [
      { id: id(10), client: 'web', deviceLabel: 'Chrome on macOS', lastUsedAt: ago(1), current: true },
      {
        id: id(11),
        client: 'native',
        deviceLabel: 'KnowScroll on iPhone',
        lastUsedAt: ago(3 * 24 * 60),
        current: false,
      },
    ],
    exports: [],
    deletion: 'in_progress',
    deleted: false,
    requests: [],
  };
  await page.route('**/auth/session', (route) =>
    fixture.deleted
      ? route.fulfill({
          status: 401,
          contentType: 'application/problem+json',
          json: { code: 'UNAUTHENTICATED', status: 401, title: 'Sign-in is required.', type: 'tag:x' },
        })
      : route.fulfill({ json: { account: scope, client: 'web', expiresAt: '2099-10-23T00:00:00.000Z' } }),
  );
  await page.route('**/auth/deletion/**', (route) => route.fulfill({ json: { state: fixture.deletion } }));
  await page.route('**/auth/exports/**', (route) =>
    route.fulfill({
      headers: { 'content-disposition': 'attachment; filename="knowscroll-export.json"' },
      contentType: 'application/json',
      body: '{"version":"knowscroll-export.v1","sections":{}}',
    }),
  );
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body: unknown = request.method() === 'POST' ? request.postDataJSON() : undefined;
    fixture.requests.push({ path, body });
    if (path === '/v1/privacy/recording/read')
      return route.fulfill({
        json: {
          version: 'recording-policy.v1',
          ...(body as object),
          scope: { accountId: scope.accountId, privacyEpoch: 1 },
          revision: 0,
          policy: { on: true, generation: 1 },
        },
      });
    if (path === '/v1/privacy/clear-exploration/status')
      return route.fulfill({
        json: {
          version: 'clear-exploration.v1',
          scope: { accountId: scope.accountId, privacyEpoch: 1 },
          target: (body as { target: unknown }).target,
          status: 'not_recorded',
        },
      });
    if (path === '/v1/account/sessions')
      return route.fulfill({ json: { sessions: fixture.sessions.map((s) => ({ ...s, signedInAt: ago(20_000) })) } });
    if (path === '/v1/account/sessions/end') {
      fixture.sessions = fixture.sessions.filter((s) => s.id !== (body as { sessionId: string }).sessionId);
      return route.fulfill({ json: { status: 'ended' } });
    }
    if (path === '/v1/account/exports' && request.method() === 'GET')
      return route.fulfill({ json: { exports: fixture.exports } });
    if (path === '/v1/account/exports') {
      fixture.exports = [
        { id: (body as { exportId: string }).exportId, state: 'preparing', requestedAt: ago(0), expiresAt: null },
      ];
      return route.fulfill({ status: 202, json: { export: fixture.exports[0] } });
    }
    if (path === '/v1/account/exports/link')
      return route.fulfill({
        json: { path: `/auth/exports/kse_${'A'.repeat(43)}`, expiresAt: new Date(Date.now() + 60_000).toISOString() },
      });
    if (path === '/v1/account/delete') {
      fixture.deleted = true;
      return route.fulfill({
        status: 202,
        headers: { 'set-cookie': 'ks_session=; Max-Age=0; Path=/' },
        json: { receiptId: (body as { receiptId: string }).receiptId, requestedAt: ago(0) },
      });
    }
    return route.fulfill({
      status: 404,
      contentType: 'application/problem+json',
      json: { code: 'NOT_FOUND', status: 404, title: 'Not found.', type: 'tag:x' },
    });
  });
  return fixture;
}

test('phone: sessions, one question before signing a device out, then a one-time export download', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await mount(page);
  await page.goto('/account');
  await expect(page.getByText('Chrome on macOS')).toBeVisible();
  await expect(page.getByText('Signed in now')).toBeVisible();
  await expect(page.getByText('Last used 3 days ago')).toBeVisible();
  await page.getByRole('button', { name: 'Sign out KnowScroll on iPhone' }).click();
  await expect(page.getByText('Sign out of KnowScroll on iPhone?')).toBeVisible();
  expect(fixture.requests.some((r) => r.path === '/v1/account/sessions/end')).toBe(false);
  await page.getByRole('button', { name: 'Confirm sign out of KnowScroll on iPhone' }).click();
  await expect(page.getByText('KnowScroll on iPhone')).toHaveCount(0);

  await page.getByRole('link', { name: 'Privacy & history' }).click();
  await expect(page).toHaveURL(/\/account\/privacy$/);
  await page.getByRole('link', { name: 'History & export' }).click();
  await page.getByRole('button', { name: 'Request a new export' }).click();
  await expect(page.getByText('Preparing')).toBeVisible();
  fixture.exports = fixture.exports.map((entry) => ({
    ...entry,
    state: 'ready',
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  }));
  const download = page.waitForEvent('download');
  await expect(page.getByRole('button', { name: 'Download' })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Download' }).click();
  expect((await download).suggestedFilename()).toBe('knowscroll-export.json');
});

test('desktop: every privacy control as a card on one page, and deletion ends in a receipt', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const fixture = await mount(page);
  await page.goto('/account/privacy/export');
  // The phone sub-pages send a desktop to the one page.
  await expect(page).toHaveURL(/\/account\/privacy$/);
  for (const name of ['History & export', 'Clear exploration', 'Delete account'])
    await expect(page.getByRole('heading', { name })).toBeVisible();
  await expect(page.getByText('Signed in as account@fixture.test')).toBeVisible();

  const button = page.getByRole('button', { name: 'Delete account' });
  await expect(button).toBeDisabled();
  await page.getByRole('checkbox', { name: 'I understand this cannot be undone' }).last().click();
  await button.click();
  await expect(page.getByText('Deletion in progress')).toBeVisible();
  await expect(page).toHaveURL(/\/account$/);
  const sent = fixture.requests.find((r) => r.path === '/v1/account/delete');
  expect(sent?.body).toMatchObject({ expectedPrivacyEpoch: 1, confirmation: 'delete-account-erase-everything' });

  fixture.deletion = 'completed';
  await page.reload();
  await expect(page.getByText('Account deleted')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText("You're not signed in")).toBeVisible();
});
