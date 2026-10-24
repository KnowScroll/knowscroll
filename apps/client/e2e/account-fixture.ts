import type { Page, Route } from '@playwright/test';
import { emptyInbox, isInboxPath } from './empty-inbox';
import { id } from './encounter-fixture';

const account = { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'axe@fixture.test' };

/** A signed-in account with an empty Talk inbox, nothing kept and no sessions beyond this one. */
export async function signedInAccount(page: Page) {
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
