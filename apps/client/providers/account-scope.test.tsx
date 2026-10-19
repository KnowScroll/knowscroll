import { useQuery } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { createAccountScopeManager, memoryStore, type AccountScope } from '@knowscroll/client-core';
import { AccountScopeProvider, useAccountScope } from './account-scope';

/**
 * The AccountScope provider (blueprint §18) over a labelled fixture `fetch` (no network, no API):
 * an account switch must stop the old scope before the new one mounts, and an answer the old
 * scope asked for that arrives afterwards must never appear in the new scope. Accounts and
 * addresses are fixtures.
 */
const accounts = {
  a: {
    accountId: '0199a000-0000-7000-8000-00000000000a',
    universeId: '0199a000-0000-7000-8000-0000000000aa',
    privacyEpoch: 1,
    email: 'a@scope.test',
  },
  b: {
    accountId: '0199b000-0000-7000-8000-00000000000b',
    universeId: '0199b000-0000-7000-8000-0000000000bb',
    privacyEpoch: 1,
    email: 'b@scope.test',
  },
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** The fixture server: the session is A until B's link is redeemed; `/v1/saved` waits for the test. */
function fixtureServer() {
  let current: typeof accounts.a = accounts.a;
  const saved: { release: (revision: number) => void; aborted: boolean }[] = [];
  const fetch = jest.fn((request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === '/auth/session')
      return Promise.resolve(json(200, { account: current, client: 'web', expiresAt: '2026-11-18T00:00:00.000Z' }));
    if (path === '/auth/redeem') {
      current = accounts.b;
      return Promise.resolve(
        json(200, {
          account: current,
          accountCreated: false,
          replayed: false,
          session: { kind: 'cookie', expiresAt: '2026-11-18T00:00:00.000Z' },
        }),
      );
    }
    if (path === '/v1/saved')
      return new Promise((resolve, reject) => {
        const entry = { release: (revision: number) => resolve(json(200, { revision, items: [] })), aborted: false };
        request.signal.addEventListener('abort', () => {
          entry.aborted = true;
          reject(new Error('aborted'));
        });
        saved.push(entry);
      });
    return Promise.resolve(json(404, {}));
  });
  return { fetch, saved };
}

function Saved({ scope }: { readonly scope: AccountScope }) {
  const query = useQuery({
    queryKey: scope.queryKey('saved'),
    queryFn: () => scope.api.experience.listSaved({}),
    retry: false,
  });
  return (
    <Text>{`${scope.account.email}: ${query.data === undefined ? 'loading' : `revision ${query.data.revision}`}`}</Text>
  );
}

function SavedOfCurrentScope() {
  const { state } = useAccountScope();
  return state.status === 'signed_in' ? <Saved scope={state.scope} /> : <Text>signed out</Text>;
}

describe('AccountScopeProvider', () => {
  it('fences a late answer for the old account: it never reaches the new scope after a switch', async () => {
    const server = fixtureServer();
    const manager = createAccountScopeManager({
      baseUrl: 'https://app.scope.test',
      platform: 'web',
      fetch: server.fetch,
      store: memoryStore(),
    });
    await render(
      <AccountScopeProvider manager={manager}>
        <SavedOfCurrentScope />
      </AccountScopeProvider>,
    );
    expect(await screen.findByText('a@scope.test: loading')).toBeOnTheScreen();
    const first = manager.getState();
    if (first.status !== 'signed_in') throw new Error('expected account A');
    const scopeA = first.scope;
    expect(server.saved).toHaveLength(1);

    // Switch accounts while A's read is still in flight.
    await act(async () => {
      await manager.redeem({ token: `ksl_${'b'.repeat(43)}`, commandId: '0199c000-0000-7000-8000-000000000001' });
    });
    expect(await screen.findByText('b@scope.test: loading')).toBeOnTheScreen();
    expect(scopeA.active).toBe(false);
    expect(server.saved[0]?.aborted).toBe(true);

    // A's answer arrives late; then B's own answer.
    await act(async () => {
      server.saved[0]?.release(41);
      await Promise.resolve();
    });
    await act(async () => {
      server.saved[1]?.release(3);
      await Promise.resolve();
    });

    expect(await screen.findByText('b@scope.test: revision 3')).toBeOnTheScreen();
    expect(screen.queryByText(/revision 41/)).toBeNull();
    const second = manager.getState();
    if (second.status !== 'signed_in') throw new Error('expected account B');
    const cached = second.scope.queryClient
      .getQueryCache()
      .getAll()
      .map((query) => ({ key: query.queryKey, data: query.state.data }));
    expect(cached).toEqual([{ key: second.scope.queryKey('saved'), data: { revision: 3, items: [] } }]);
    expect(scopeA.queryClient.getQueryCache().getAll()).toEqual([]);
  });

  it('renders the signed-out state once the session is known, and nothing before', async () => {
    const manager = createAccountScopeManager({
      baseUrl: 'https://app.scope.test',
      platform: 'web',
      fetch: () => Promise.resolve(json(401, {})),
      store: memoryStore(),
    });
    await render(
      <AccountScopeProvider manager={manager}>
        <SavedOfCurrentScope />
      </AccountScopeProvider>,
    );
    expect(await screen.findByText('signed out')).toBeOnTheScreen();
    expect(manager.getState()).toEqual({ status: 'signed_out', reason: 'none' });
  });
});
