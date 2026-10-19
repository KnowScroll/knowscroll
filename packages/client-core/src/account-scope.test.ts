import { describe, expect, it, vi } from 'vitest';
import { ScopeEndedError, createAccountScope, memoryStore, scopeIdOf } from './account-scope';
import { createAccountScopeManager, type SessionTokenStore } from './account-scope-manager';

/**
 * The AccountScope (blueprint §18) with labelled test doubles for `fetch`: no network, no API.
 * Accounts, universes and addresses are fixtures.
 */
const accountA = {
  accountId: '0199a000-0000-7000-8000-00000000000a',
  universeId: '0199a000-0000-7000-8000-0000000000aa',
  privacyEpoch: 1,
  email: 'a@scope.test',
};
const accountB = { ...accountA, accountId: '0199b000-0000-7000-8000-00000000000b', email: 'b@scope.test' };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** A fixture `fetch` whose `/v1/saved` answers wait until the test releases them. */
function deferredApi() {
  const pending: { url: string; authorization: string | null; release: (response: Response) => void }[] = [];
  const fetch = vi.fn(
    (request: Request) =>
      new Promise<Response>((resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        pending.push({ url: request.url, authorization: request.headers.get('authorization'), release: resolve });
      }),
  );
  return { fetch, pending };
}

const saved = (revision: number) => json(200, { revision, items: [] });

describe('an account scope', () => {
  it('drops a late response: a request of an ended scope never resolves into any cache', async () => {
    const api = deferredApi();
    const store = memoryStore();
    const scope = createAccountScope({
      account: accountA,
      baseUrl: 'https://app.scope.test',
      fetch: api.fetch,
      authorization: () => undefined,
      store,
    });
    const read = scope.queryClient.fetchQuery({
      queryKey: scope.queryKey('saved'),
      queryFn: () => scope.api.experience.listSaved({}),
      retry: false,
    });
    await vi.waitFor(() => expect(api.pending).toHaveLength(1));
    scope.storage.set('resume', 'scroll@12');
    scope.end();
    api.pending[0]?.release(saved(7));
    await expect(read).rejects.toBeInstanceOf(Error);
    expect(scope.active).toBe(false);
    expect(scope.queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(store.keys()).toEqual([]);
    // Nothing can be started through it any more.
    await expect(scope.api.experience.listSaved({})).rejects.toThrow(ScopeEndedError);
  });

  it('closes its socket before anything else when it ends, and confines its storage', () => {
    const order: string[] = [];
    const store = memoryStore();
    store.setItem('unrelated', 'kept');
    const scope = createAccountScope({
      account: accountA,
      baseUrl: 'https://app.scope.test',
      fetch: deferredApi().fetch,
      authorization: () => undefined,
      store,
      connect: () => ({ close: () => order.push(`socket closed, active=${String(scope.active)}`) }),
    });
    scope.storage.set('draft', 'x');
    expect(store.keys()).toEqual(['unrelated', `ks.scope.${scopeIdOf(accountA)}.draft`]);
    scope.end();
    scope.end();
    expect(order).toEqual(['socket closed, active=true']);
    expect(store.keys()).toEqual(['unrelated']);
  });
});

function fakeAuth(sessions: { current: typeof accountA | undefined }) {
  return {
    requestLink: vi.fn(() => Promise.resolve({ kind: 'requested' as const })),
    redeem: vi.fn((request: { token: string }) => {
      const account = request.token.endsWith('B') ? accountB : accountA;
      sessions.current = account;
      return Promise.resolve({
        kind: 'signed_in' as const,
        response: {
          account,
          accountCreated: false,
          replayed: false,
          session: { kind: 'bearer' as const, token: `kss_${account.email}`, expiresAt: '2026-11-18T00:00:00.000Z' },
        },
      });
    }),
    session: vi.fn(() =>
      Promise.resolve(
        sessions.current === undefined
          ? { kind: 'signed_out' as const }
          : {
              kind: 'signed_in' as const,
              account: sessions.current,
              client: 'native' as const,
              expiresAt: '2026-11-18T00:00:00.000Z',
            },
      ),
    ),
    signOut: vi.fn(() => {
      sessions.current = undefined;
      return Promise.resolve('signed_out' as const);
    }),
  };
}

function tokenStore(initial?: string): SessionTokenStore & { value: string | undefined } {
  const store = {
    value: initial,
    read: () => Promise.resolve(store.value),
    write: (token: string) => {
      store.value = token;
      return Promise.resolve();
    },
    clear: () => {
      store.value = undefined;
      return Promise.resolve();
    },
  };
  return store;
}

describe('the account scope manager', () => {
  it('switching accounts ends the old scope before the new one exists, and the late answer reaches neither', async () => {
    const api = deferredApi();
    const sessions = { current: undefined as typeof accountA | undefined };
    const tokens = tokenStore();
    const manager = createAccountScopeManager({
      baseUrl: 'https://app.scope.test',
      platform: 'native',
      fetch: api.fetch,
      tokens,
      store: memoryStore(),
      auth: fakeAuth(sessions),
    });
    await manager.start();
    expect(manager.getState()).toEqual({ status: 'signed_out', reason: 'none' });

    await manager.redeem({ token: 'ksl_A', commandId: '0199c000-0000-7000-8000-000000000001' });
    const first = manager.getState();
    if (first.status !== 'signed_in') throw new Error('not signed in');
    const scopeA = first.scope;
    const lateRead = scopeA.queryClient.fetchQuery({
      queryKey: scopeA.queryKey('saved'),
      queryFn: () => scopeA.api.experience.listSaved({}),
      retry: false,
    });
    await vi.waitFor(() => expect(api.pending).toHaveLength(1));
    expect(api.pending[0]?.authorization).toBe('Bearer kss_a@scope.test');

    await manager.redeem({ token: 'ksl_B', commandId: '0199c000-0000-7000-8000-000000000002' });
    const second = manager.getState();
    if (second.status !== 'signed_in') throw new Error('not signed in');
    const scopeB = second.scope;
    expect(scopeB.id).toBe(scopeIdOf(accountB));
    expect(scopeA.active).toBe(false);
    expect(tokens.value).toBe('kss_b@scope.test');

    // A's answer arrives after the switch.
    api.pending[0]?.release(saved(41));
    await expect(lateRead).rejects.toBeInstanceOf(Error);
    for (const client of [scopeA.queryClient, scopeB.queryClient, manager.queryClient()])
      expect(
        client
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ).toEqual([]);
    expect(manager.queryClient()).toBe(scopeB.queryClient);
  });

  it('remounts on a new privacy epoch, ends the scope when the session ends, and forgets the token on sign-out', async () => {
    const sessions = { current: accountA as typeof accountA | undefined };
    const tokens = tokenStore('kss_stored');
    const manager = createAccountScopeManager({
      baseUrl: 'https://app.scope.test',
      platform: 'native',
      fetch: deferredApi().fetch,
      tokens,
      store: memoryStore(),
      auth: fakeAuth(sessions),
    });
    await manager.start();
    const first = manager.getState();
    if (first.status !== 'signed_in') throw new Error('not signed in');
    sessions.current = { ...accountA, privacyEpoch: 2 };
    await manager.refresh();
    const second = manager.getState();
    if (second.status !== 'signed_in') throw new Error('not signed in');
    expect(first.scope.active).toBe(false);
    expect(second.scope.id).toBe(`${accountA.accountId}:2`);

    sessions.current = undefined;
    await manager.refresh();
    expect(manager.getState()).toEqual({ status: 'signed_out', reason: 'session_ended' });
    expect(second.scope.active).toBe(false);
    expect(tokens.value).toBeUndefined();

    sessions.current = accountA;
    tokens.value = 'kss_again';
    await manager.refresh();
    expect(manager.getState().status).toBe('signed_in');
    expect(await manager.signOut()).toBe('signed_out');
    expect(manager.getState()).toEqual({ status: 'signed_out', reason: 'signed_out' });
    expect(tokens.value).toBeUndefined();
  });

  it('starts signed out on native without a stored token, and unavailable when the API cannot be asked', async () => {
    const auth = {
      ...fakeAuth({ current: accountA }),
      session: vi.fn(() => Promise.resolve({ kind: 'unavailable' as const })),
    };
    const native = createAccountScopeManager({
      baseUrl: 'https://app.scope.test',
      platform: 'native',
      tokens: tokenStore(),
      store: memoryStore(),
      auth,
    });
    await native.start();
    expect(native.getState()).toEqual({ status: 'signed_out', reason: 'none' });
    expect(auth.session).not.toHaveBeenCalled();

    const web = createAccountScopeManager({
      baseUrl: 'https://app.scope.test',
      platform: 'web',
      store: memoryStore(),
      auth,
    });
    await web.start();
    expect(web.getState()).toEqual({ status: 'unavailable' });
  });
});
