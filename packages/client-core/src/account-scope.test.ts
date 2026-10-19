import { describe, expect, it, vi } from 'vitest';
import { problemDetails } from '@knowscroll/contracts';
import { ScopeEndedError, createAccountScope, memoryStore, scopeIdOf } from './account-scope';
import { createAccountScopeManager, type SessionTokenStore, type SignInBinding } from './account-scope-manager';

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

  it('sends a command through the fence with its body, the scope bearer header and its scope claim', async () => {
    const seen: { method: string; authorization: string | null; scope: string | null; body: unknown }[] = [];
    const scope = createAccountScope({
      account: accountA,
      baseUrl: 'https://app.scope.test',
      fetch: async (request) => {
        seen.push({
          method: request.method,
          authorization: request.headers.get('authorization'),
          scope: request.headers.get('x-ks-scope'),
          body: await request.json(),
        });
        return json(200, {
          commandId: '0199c000-0000-7000-8000-000000000009',
          actionId: '0199c000-0000-7000-8000-000000000010',
          kind: 'save',
          assetId: '0199c000-0000-7000-8000-000000000011',
          assetRevision: 1,
          saved: true,
          changed: true,
          revision: 1,
          replayed: false,
        });
      },
      authorization: () => 'Bearer kss_fixture',
      store: memoryStore(),
    });
    const command = {
      commandId: '0199c000-0000-7000-8000-000000000009',
      kind: 'save' as const,
      target: { assetId: '0199c000-0000-7000-8000-000000000011', assetRevision: 1 },
    };
    await expect(scope.api.experience.applyAction(command)).resolves.toMatchObject({ saved: true });
    expect(seen).toEqual([
      { method: 'POST', authorization: 'Bearer kss_fixture', scope: scopeIdOf(accountA), body: command },
    ]);
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
    requestLink: vi.fn((_email: string, _challenge?: string) => Promise.resolve({ kind: 'requested' as const })),
    peek: vi.fn(() => Promise.resolve({ kind: 'usable' as const, email: 'b@scope.test' })),
    redeem: vi.fn((request: { token: string; codeVerifier?: string }) => {
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

  it('fences the old scope before a switching redemption is sent: nothing it starts goes out with the new credential (review M1)', async () => {
    // The review's proof (switch-race.mjs): signed in as A, redeem B's link while the secure-store
    // write of B's token is still pending; A's scope makes a request in that window.
    const seen: { url: string; authorization: string | null; scope: string | null }[] = [];
    const fetch = vi.fn((request: Request) => {
      seen.push({
        url: new URL(request.url).pathname,
        authorization: request.headers.get('authorization'),
        scope: request.headers.get('x-ks-scope'),
      });
      return Promise.resolve(saved(0));
    });
    const sessions = { current: accountA as typeof accountA | undefined };
    let releaseWrite: (() => void) | undefined;
    const tokens: SessionTokenStore = {
      read: () => Promise.resolve('kss_a@scope.test'),
      write: () =>
        new Promise<void>((resolve) => {
          releaseWrite = resolve;
        }),
      clear: () => Promise.resolve(),
    };
    const manager = createAccountScopeManager({
      baseUrl: 'https://app.scope.test',
      platform: 'native',
      fetch,
      tokens,
      store: memoryStore(),
      auth: fakeAuth(sessions),
    });
    await manager.start();
    const first = manager.getState();
    if (first.status !== 'signed_in') throw new Error('not signed in');
    const scopeA = first.scope;
    await scopeA.api.experience.listSaved({});

    const redeeming = manager.redeem({ token: 'ksl_B', commandId: '0199c000-0000-7000-8000-000000000003' });
    expect(scopeA.active).toBe(false);
    await vi.waitFor(() => expect(releaseWrite).toBeDefined());
    // The redemption answered; B's token is being written. A's refetch, hint or queued command:
    await expect(scopeA.api.experience.listSaved({})).rejects.toThrow(ScopeEndedError);
    releaseWrite?.();
    await redeeming;
    const second = manager.getState();
    if (second.status !== 'signed_in') throw new Error('not signed in');
    await second.scope.api.experience.listSaved({});

    expect(seen).toEqual([
      { url: '/v1/saved', authorization: 'Bearer kss_a@scope.test', scope: scopeIdOf(accountA) },
      { url: '/v1/saved', authorization: 'Bearer kss_b@scope.test', scope: scopeIdOf(accountB) },
    ]);
  });

  it('keeps a scope on its own credential: an ended scope never borrows the next one', async () => {
    const seen: (string | null)[] = [];
    const sessions = { current: accountA as typeof accountA | undefined };
    const manager = createAccountScopeManager({
      baseUrl: 'https://app.scope.test',
      platform: 'native',
      fetch: (request) => {
        seen.push(request.headers.get('authorization'));
        return Promise.resolve(saved(0));
      },
      tokens: tokenStore('kss_a@scope.test'),
      store: memoryStore(),
      auth: fakeAuth(sessions),
    });
    await manager.start();
    const first = manager.getState();
    if (first.status !== 'signed_in') throw new Error('not signed in');
    await manager.redeem({ token: 'ksl_B', commandId: '0199c000-0000-7000-8000-000000000004' });
    await expect(first.scope.api.experience.listSaved({})).rejects.toThrow(ScopeEndedError);
    const second = manager.getState();
    if (second.status !== 'signed_in') throw new Error('not signed in');
    await second.scope.api.experience.listSaved({});
    expect(seen).toEqual(['Bearer kss_b@scope.test']);
  });

  it('rereads the session when the API refuses a request as another scope’s: another tab switched account, or the epoch changed (review M1, m11)', async () => {
    const sessions = { current: accountA as typeof accountA | undefined };
    const auth = fakeAuth(sessions);
    const mismatch = new Response(JSON.stringify(problemDetails('SCOPE_MISMATCH')), {
      status: 409,
      headers: { 'content-type': 'application/problem+json' },
    });
    const answers: Response[] = [mismatch.clone(), mismatch.clone()];
    const claims: (string | null)[] = [];
    const manager = createAccountScopeManager({
      baseUrl: 'https://app.scope.test',
      platform: 'web',
      fetch: (request) => {
        claims.push(request.headers.get('x-ks-scope'));
        return Promise.resolve(answers.shift() ?? saved(3));
      },
      store: memoryStore(),
      auth,
    });
    await manager.start();
    const first = manager.getState();
    if (first.status !== 'signed_in') throw new Error('not signed in');

    // Another tab signed into B: this tab's cookie is B's now, its scope still A's.
    sessions.current = accountB;
    await expect(first.scope.api.experience.listSaved({})).rejects.toThrow();
    await vi.waitFor(() => {
      const state = manager.getState();
      expect(state.status === 'signed_in' ? state.scope.id : state.status).toBe(scopeIdOf(accountB));
    });
    expect(first.scope.active).toBe(false);

    // A privacy reset whose revocation notice never arrived: B's epoch is 2 on the server.
    const scopeB = manager.getState();
    if (scopeB.status !== 'signed_in') throw new Error('not signed in');
    sessions.current = { ...accountB, privacyEpoch: 2 };
    await expect(scopeB.scope.api.experience.listSaved({})).rejects.toThrow();
    await vi.waitFor(() => {
      const state = manager.getState();
      expect(state.status === 'signed_in' ? state.scope.id : state.status).toBe(`${accountB.accountId}:2`);
    });
    const third = manager.getState();
    if (third.status !== 'signed_in') throw new Error('not signed in');
    await expect(third.scope.api.experience.listSaved({})).resolves.toMatchObject({ revision: 3 });
    expect(claims).toEqual([scopeIdOf(accountA), scopeIdOf(accountB), `${accountB.accountId}:2`]);
  });

  it('remounts the current account afresh when a switching redemption does not sign in', async () => {
    const sessions = { current: accountA as typeof accountA | undefined };
    const auth = {
      ...fakeAuth(sessions),
      redeem: vi.fn(() => Promise.resolve({ kind: 'link_invalid' as const })),
    };
    const manager = createAccountScopeManager({
      baseUrl: 'https://app.scope.test',
      platform: 'web',
      fetch: () => Promise.resolve(saved(0)),
      store: memoryStore(),
      auth,
    });
    await manager.start();
    const first = manager.getState();
    if (first.status !== 'signed_in') throw new Error('not signed in');
    expect(await manager.redeem({ token: 'ksl_B', commandId: '0199c000-0000-7000-8000-000000000005' })).toEqual({
      kind: 'link_invalid',
    });
    const second = manager.getState();
    if (second.status !== 'signed_in') throw new Error('not signed in');
    expect(first.scope.active).toBe(false);
    expect(second.scope).not.toBe(first.scope);
    expect(second.scope.id).toBe(scopeIdOf(accountA));
    expect(second.scope.active).toBe(true);
  });

  it('binds a native link to the device: asks with the challenge, redeems with the verifier, then forgets it (review m10)', async () => {
    const sessions = { current: undefined as typeof accountA | undefined };
    const auth = fakeAuth(sessions);
    let verifier: string | undefined;
    const binding: SignInBinding = {
      challenge: () => {
        verifier ??= 'v'.repeat(43);
        return Promise.resolve('c'.repeat(43));
      },
      verifier: () => Promise.resolve(verifier),
      clear: () => {
        verifier = undefined;
        return Promise.resolve();
      },
    };
    const manager = createAccountScopeManager({
      baseUrl: 'https://app.scope.test',
      platform: 'native',
      fetch: () => Promise.resolve(saved(0)),
      tokens: tokenStore(),
      signInBinding: binding,
      store: memoryStore(),
      auth,
    });
    await manager.start();
    expect(await manager.requestLink(' a@scope.test ')).toEqual({ kind: 'requested' });
    expect(auth.requestLink).toHaveBeenCalledWith(' a@scope.test ', 'c'.repeat(43));
    expect(manager.pendingEmail).toBe('a@scope.test');
    await manager.redeem({ token: 'ksl_A', commandId: '0199c000-0000-7000-8000-000000000006' });
    expect(auth.redeem).toHaveBeenCalledWith(
      expect.objectContaining({ client: 'native', codeVerifier: 'v'.repeat(43) }),
    );
    expect(verifier).toBeUndefined();
    expect(manager.getState().status).toBe('signed_in');

    // The web never binds a link.
    const webAuth = fakeAuth({ current: undefined });
    const web = createAccountScopeManager({
      baseUrl: 'https://app.scope.test',
      platform: 'web',
      store: memoryStore(),
      signInBinding: binding,
      auth: webAuth,
    });
    await web.requestLink('a@scope.test');
    expect(webAuth.requestLink).toHaveBeenCalledWith('a@scope.test', undefined);
  });

  /** The review's stale-refresh probes: a reread sent with A's credential answers after a switch to B. */
  function staleReread(lateAnswer: 'A' | 'signed_out') {
    const seen: { authorization: string | null; scope: string | null }[] = [];
    let stored: string | undefined = 'kss_a@scope.test';
    const tokens: SessionTokenStore = {
      read: () => Promise.resolve(stored),
      write: (value) => {
        stored = value;
        return Promise.resolve();
      },
      clear: () => {
        stored = undefined;
        return Promise.resolve();
      },
    };
    let sessionCalls = 0;
    const releases: (() => void)[] = [];
    const auth = {
      ...fakeAuth({ current: accountA }),
      session: vi.fn(() => {
        sessionCalls += 1;
        const signedInA = {
          kind: 'signed_in' as const,
          account: accountA,
          client: 'native' as const,
          expiresAt: '2026-11-18T00:00:00.000Z',
        };
        if (sessionCalls === 1) return Promise.resolve(signedInA);
        return new Promise<typeof signedInA | { kind: 'signed_out' }>((resolve) => {
          releases.push(() => resolve(lateAnswer === 'A' ? signedInA : { kind: 'signed_out' }));
        });
      }),
    };
    const manager = createAccountScopeManager({
      baseUrl: 'https://app.scope.test',
      platform: 'native',
      fetch: (request) => {
        seen.push({ authorization: request.headers.get('authorization'), scope: request.headers.get('x-ks-scope') });
        return Promise.resolve(saved(0));
      },
      tokens,
      store: memoryStore(),
      auth,
    });
    return {
      manager,
      seen,
      stored: () => stored,
      release: () => {
        for (const release of releases.splice(0)) release();
      },
    };
  }

  it('ignores a session reread that answers for the account before a switch (re-review N5, stale-refresh)', async () => {
    const probe = staleReread('A');
    await probe.manager.start();
    const rereading = probe.manager.refresh();
    await probe.manager.redeem({ token: 'ksl_B', commandId: '0199c000-0000-7000-8000-000000000007' });
    const switched = probe.manager.getState();
    if (switched.status !== 'signed_in') throw new Error('not signed in');
    probe.release();
    await rereading;
    const after = probe.manager.getState();
    if (after.status !== 'signed_in') throw new Error('not signed in');
    // B's scope stays: the late answer for A mounted nothing.
    expect(after.scope).toBe(switched.scope);
    expect(after.scope.id).toBe(scopeIdOf(accountB));
    await after.scope.api.experience.listSaved({});
    expect(probe.seen.at(-1)).toEqual({ authorization: 'Bearer kss_b@scope.test', scope: scopeIdOf(accountB) });
  });

  it('ignores a late "signed out" for the replaced session: no sign-out, no secure-store wipe (re-review N5, stale-refresh-401)', async () => {
    const probe = staleReread('signed_out');
    await probe.manager.start();
    const rereading = probe.manager.refresh();
    await probe.manager.redeem({ token: 'ksl_B', commandId: '0199c000-0000-7000-8000-000000000008' });
    probe.release();
    await rereading;
    const state = probe.manager.getState();
    expect(state.status).toBe('signed_in');
    if (state.status === 'signed_in') expect(state.scope.id).toBe(scopeIdOf(accountB));
    expect(probe.stored()).toBe('kss_b@scope.test');
  });

  it('a reread after the switch is a new one, not the stale one in flight', async () => {
    const probe = staleReread('A');
    await probe.manager.start();
    const stale = probe.manager.refresh();
    await probe.manager.redeem({ token: 'ksl_B', commandId: '0199c000-0000-7000-8000-000000000009' });
    const fresh = probe.manager.refresh();
    expect(fresh).not.toBe(stale);
    probe.release();
    await Promise.all([stale, fresh]);
  });
});
