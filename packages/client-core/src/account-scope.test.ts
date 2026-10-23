import { describe, expect, it, vi } from 'vitest';
import { problemDetails } from '@knowscroll/contracts';
import {
  ScopeEndedError,
  createAccountScope,
  fencedFetch,
  memoryStore,
  scopeIdOf,
  type ScopeStorageLifecycle,
  type KeyValueStore,
} from './account-scope';
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
  it('stops playback synchronously and fences media sources even when native cleanup throws', () => {
    const scope = createAccountScope({
      account: accountA,
      baseUrl: 'https://app.scope.test',
      fetch: deferredApi().fetch,
      authorization: () => 'Bearer fixture-media-canary',
      store: memoryStore(),
    });
    let activeWhenStopped: boolean | undefined;
    const stopped = vi.fn(() => {
      activeWhenStopped = scope.active;
      throw new Error('native already released');
    });
    scope.onEnd?.(stopped);
    expect(scope.mediaSource?.('/media/digest?grant=fixture')).toEqual({
      uri: 'https://app.scope.test/media/digest?grant=fixture',
      headers: { authorization: 'Bearer fixture-media-canary' },
    });
    scope.end();
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(activeWhenStopped).toBe(true);
    expect(scope.active).toBe(false);
    expect(() => scope.mediaSource?.('/media/digest?grant=fixture')).toThrow(ScopeEndedError);
    scope.end();
    expect(stopped).toHaveBeenCalledTimes(1);
  });

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

  it('fences storage handles retained by late callbacks after a purge', async () => {
    const store = memoryStore();
    const scope = createAccountScope({
      account: accountA,
      baseUrl: 'https://app.scope.test',
      fetch: deferredApi().fetch,
      authorization: () => undefined,
      store,
    });
    const retained = scope.storage;
    retained.set('resume', 'top-block');
    scope.end();
    await Promise.resolve();
    retained.set('resume', 'unmount-block');
    retained.set('late-response', 'private-value');
    retained.remove('resume');
    expect(retained.get('resume')).toBeUndefined();
    expect(store.keys()).toEqual([]);
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

it('a Clear-style new epoch reacquires generation5 instead of resetting it, and old reads stay fenced (CI fixture)', async () => {
  const store = memoryStore();
  let wait: Promise<void> | undefined;
  let next = 100;
  const create = (privacyEpoch: number) =>
    createAccountScope({
      account: { ...accountA, privacyEpoch },
      baseUrl: 'https://recording-scope.fixture.test',
      authorization: () => undefined,
      store,
      fetch: async (request) => {
        const input = (await request.json()) as { readId: string; target: unknown };
        const expected = `${accountA.accountId}:${privacyEpoch}`;
        expect(request.headers.get('x-ks-scope')).toBe(expected);
        await wait;
        return json(200, {
          version: 'recording-policy.v1',
          ...input,
          scope: { accountId: accountA.accountId, privacyEpoch },
          revision: 20,
          policy: { on: true, generation: 5 },
        });
      },
    });
  const old = create(1);
  old.recording!.useIdSource(() => `0199a000-0000-7000-8000-${String(next++).padStart(12, '0')}`);
  await old.recording!.refresh();
  expect(old.recording!.getState().policy?.generation).toBe(5);
  old.storage.set('recorder.outbox.v2', 'labelled old-scope storage fixture');
  let release!: () => void;
  wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const late = old.recording!.refresh();
  old.end();
  expect(store.keys()).toEqual([]);
  wait = undefined;
  const fresh = create(2);
  fresh.recording!.useIdSource(() => `0199a000-0000-7000-8000-${String(next++).padStart(12, '0')}`);
  await fresh.recording!.refresh();
  release();
  await late;
  expect(old.recording!.getState()).toMatchObject({ status: 'ended', collecting: false });
  expect(fresh.recording!.getState()).toMatchObject({ status: 'current', collecting: true, policy: { generation: 5 } });
  expect(fresh.id).toBe(`${accountA.accountId}:2`);
  fresh.end();
});

/** Lifecycle/commit ports only; actual native transaction fixtures live in the app package. */
function nativeLifecycleFixture() {
  const prepared: {
    epoch: number;
    accountId: string;
    credential: string;
    current: () => boolean;
    store: KeyValueStore;
  }[] = [];
  let prepareGate: Promise<void> | undefined;
  let purgeGate: Promise<void> | undefined;
  let failedPurge = false;
  let runtime: KeyValueStore | undefined;
  const fences: string[] = [];
  const lifecycle: ScopeStorageLifecycle = {
    async prepare(input, current) {
      const base = memoryStore();
      let active = true;
      const store: KeyValueStore = {
        ...base,
        durability: {
          flush(expected) {
            return Promise.resolve(
              active && Object.entries(expected).every(([k, v]) => (base.getItem(k) ?? undefined) === v),
            );
          },
          healthy: () => active,
          group: (work) => work(),
          subscribe: () => () => undefined,
          fence() {
            active = false;
            fences.push(input.account.accountId);
          },
          async purge() {
            active = false;
            await purgeGate;
            if (failedPurge) throw new Error('fixture close failed');
            for (const k of base.keys()) base.removeItem(k);
          },
        },
      };
      prepared.push({
        epoch: input.account.privacyEpoch,
        accountId: input.account.accountId,
        credential: input.credential,
        current,
        store,
      });
      await prepareGate;
      runtime = store;
      return store;
    },
    fence() {
      runtime?.durability?.fence();
    },
    async purge() {
      await runtime?.durability?.purge();
      if (failedPurge) throw new Error('fixture close failed');
    },
  };
  return {
    lifecycle,
    prepared,
    fences,
    holdPrepare(value?: Promise<void>) {
      prepareGate = value;
    },
    holdPurge(value?: Promise<void>) {
      purgeGate = value;
    },
    failPurge(value: boolean) {
      failedPurge = value;
    },
  };
}

it('native scope publication waits for hydration, and a late prepared A cannot publish after switching to B (CI lifecycle ports)', async () => {
  const f = nativeLifecycleFixture();
  let release!: () => void;
  f.holdPrepare(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const sessions = { current: accountA as typeof accountA | undefined };
  const tokens = tokenStore('kss_a@scope.test');
  const manager = createAccountScopeManager({
    baseUrl: 'https://app.scope.test',
    platform: 'native',
    store: memoryStore(),
    tokens,
    auth: fakeAuth(sessions),
    durableStorage: f.lifecycle,
  });
  const start = manager.start();
  await vi.waitFor(() => expect(f.prepared).toHaveLength(1));
  expect(manager.getState()).toEqual({ status: 'starting' });
  expect(f.prepared[0]!.current()).toBe(true);
  f.holdPrepare();
  const switching = manager.redeem({ token: 'ksl_B', commandId: '0199c000-0000-7000-8000-000000000101' });
  await vi.waitFor(() => expect(f.prepared).toHaveLength(2));
  await switching;
  const current = manager.getState();
  if (current.status !== 'signed_in') throw new Error('expected B');
  expect(current.scope.id).toBe(scopeIdOf(accountB));
  expect(f.prepared[0]!.current()).toBe(false);
  release();
  await start;
  expect(manager.getState()).toBe(current);
  expect(f.prepared[0]!.store.durability!.healthy()).toBe(false);
  expect(current.scope.active).toBe(true);
  expect(tokens.value).toBe('kss_b@scope.test');
  manager.dispose();
});

it('native sign-out fences retained work before its server request and waits for root cleanup before token clear (CI lifecycle ports)', async () => {
  const f = nativeLifecycleFixture();
  const sessions = { current: accountA as typeof accountA | undefined };
  const tokens = tokenStore('kss_stored');
  let releaseServer!: () => void;
  const auth = {
    ...fakeAuth(sessions),
    signOut: vi.fn(async () => {
      expect(scope.active).toBe(false);
      await new Promise<void>((resolve) => {
        releaseServer = resolve;
      });
      return 'unavailable' as const;
    }),
  };
  const manager = createAccountScopeManager({
    baseUrl: 'https://app.scope.test',
    platform: 'native',
    store: memoryStore(),
    tokens,
    auth,
    durableStorage: f.lifecycle,
  });
  await manager.start();
  const state = manager.getState();
  if (state.status !== 'signed_in') throw new Error('expected A');
  const scope = state.scope;
  scope.storage.set('resume', 'private');
  let releasePurge!: () => void;
  f.holdPurge(
    new Promise<void>((resolve) => {
      releasePurge = resolve;
    }),
  );
  const leaving = manager.signOut();
  expect(scope.active).toBe(false);
  scope.storage.set('resume', 'late');
  await expect(scope.api.experience.listSaved({})).rejects.toThrow(ScopeEndedError);
  expect(auth.signOut).toHaveBeenCalledTimes(1);
  releaseServer();
  await Promise.resolve();
  expect(tokens.value).toBe('kss_stored');
  expect(manager.getState().status).not.toBe('signed_out');
  releasePurge();
  expect(await leaving).toBe('signed_out');
  expect(tokens.value).toBeUndefined();
  expect(manager.getState()).toEqual({ status: 'signed_out', reason: 'signed_out' });
});

it.each(['root_cleanup', 'token_clear', 'token_read'] as const)(
  'native %s failure stays unavailable instead of claiming signed-out cleanup (CI lifecycle ports)',
  async (failure) => {
    const f = nativeLifecycleFixture();
    const auth = fakeAuth({ current: accountA });
    const base = tokenStore('kss_stored');
    const tokens = {
      ...base,
      read: failure === 'token_read' ? () => Promise.reject(new Error('locked')) : () => base.read(),
      clear: failure === 'token_clear' ? () => Promise.reject(new Error('commit false')) : () => base.clear(),
    };
    const manager = createAccountScopeManager({
      baseUrl: 'https://app.scope.test',
      platform: 'native',
      store: memoryStore(),
      tokens,
      auth,
      durableStorage: f.lifecycle,
    });
    await manager.start();
    if (failure === 'token_read') {
      expect(auth.session).not.toHaveBeenCalled();
    } else {
      const state = manager.getState();
      if (state.status !== 'signed_in') throw new Error('expected A');
      if (failure === 'root_cleanup') f.failPurge(true);
      expect(await manager.signOut()).toBe('unavailable');
      expect(state.scope.active).toBe(false);
    }
    expect(manager.getState()).toEqual({ status: 'unavailable' });
    expect(base.value).toBe('kss_stored');
    manager.dispose();
  },
);

it('Clear-style native remount waits for old cleanup and real epoch read, preserves the bearer and starts without recording authority (CI lifecycle ports)', async () => {
  const f = nativeLifecycleFixture();
  const sessions = { current: accountA as typeof accountA | undefined };
  const tokens = tokenStore('kss_same_bearer');
  const auth = fakeAuth(sessions);
  const manager = createAccountScopeManager({
    baseUrl: 'https://app.scope.test',
    platform: 'native',
    store: memoryStore(),
    tokens,
    auth,
    durableStorage: f.lifecycle,
  });
  await manager.start();
  const first = manager.getState();
  if (first.status !== 'signed_in') throw new Error('expected A');
  let release!: () => void;
  f.holdPurge(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  sessions.current = { ...accountA, privacyEpoch: 2 };
  const refreshing = manager.refresh();
  await vi.waitFor(() => expect(first.scope.active).toBe(false));
  expect(f.prepared).toHaveLength(1);
  release();
  await refreshing;
  const second = manager.getState();
  if (second.status !== 'signed_in') throw new Error('expected new epoch');
  expect(second.scope.id).toBe(`${accountA.accountId}:2`);
  expect(f.prepared.map((p) => [p.epoch, p.credential])).toEqual([
    [1, 'kss_same_bearer'],
    [2, 'kss_same_bearer'],
  ]);
  expect(auth.session).toHaveBeenCalledTimes(2);
  expect(tokens.value).toBe('kss_same_bearer');
  expect(second.scope.recording!.getState()).toEqual({ status: 'checking', retryOriginal: false, collecting: false });
  manager.dispose();
});

it('late native credential failures cannot replace a newer signed-in state (CI lifecycle ports)', async () => {
  const f = nativeLifecycleFixture();
  const sessions = { current: accountA as typeof accountA | undefined };
  const base = tokenStore('kss_old');
  let failRead!: (error: Error) => void;
  const tokens = {
    ...base,
    read: () =>
      new Promise<string | undefined>((_resolve, reject) => {
        failRead = reject;
      }),
  };
  const manager = createAccountScopeManager({
    baseUrl: 'https://app.scope.test',
    platform: 'native',
    store: memoryStore(),
    tokens,
    auth: fakeAuth(sessions),
    durableStorage: f.lifecycle,
  });
  const starting = manager.start();
  await manager.redeem({ token: 'ksl_B', commandId: '0199c000-0000-7000-8000-000000000102' });
  const current = manager.getState();
  expect(current.status).toBe('signed_in');
  failRead(new Error('old keychain read failed'));
  await starting;
  expect(manager.getState()).toBe(current);
  manager.dispose();
});

it('native preparation cannot start before genuine session authentication resolves (CI lifecycle ports)', async () => {
  const f = nativeLifecycleFixture(),
    base = fakeAuth({ current: accountA });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const auth = {
    ...base,
    session: async () => {
      await held;
      return base.session();
    },
  };
  const manager = createAccountScopeManager({
    baseUrl: 'https://app.scope.test',
    platform: 'native',
    tokens: tokenStore('kss_stored'),
    store: memoryStore(),
    durableStorage: f.lifecycle,
    auth,
  });
  const starting = manager.start();
  await Promise.resolve();
  expect(f.prepared).toEqual([]);
  expect(manager.getState()).toEqual({ status: 'starting' });
  release();
  await starting;
  expect(f.prepared).toHaveLength(1);
  expect(manager.getState().status).toBe('signed_in');
  manager.dispose();
});

it('a reentrant native publication subscriber cannot leave its replaced scope alive (CI lifecycle ports)', async () => {
  const f = nativeLifecycleFixture(),
    auth = fakeAuth({ current: accountA });
  const manager = createAccountScopeManager({
    baseUrl: 'https://app.scope.test',
    platform: 'native',
    tokens: tokenStore('kss_stored'),
    store: memoryStore(),
    durableStorage: f.lifecycle,
    auth,
  });
  let old: ReturnType<typeof createAccountScope> | undefined, switching: Promise<unknown> | undefined;
  manager.subscribe(() => {
    const state = manager.getState();
    if (state.status === 'signed_in' && state.scope.account.accountId === accountA.accountId && !old) {
      old = state.scope;
      switching = manager.redeem({ token: 'ksl_B', commandId: '0199c000-0000-7000-8000-000000000103' });
    }
  });
  await manager.start();
  await switching;
  expect(old?.active).toBe(false);
  const state = manager.getState();
  if (state.status !== 'signed_in') throw new Error('expected reentrant B');
  expect(state.scope.id).toBe(scopeIdOf(accountB));
  expect(state.scope.active).toBe(true);
  expect(state.scope).not.toBe(old);
  expect(f.prepared).toHaveLength(2);
  manager.dispose();
});

it('manager Clear confirms old native cleanup before remounting the genuinely reread epoch with the same bearer (CI HTTP/lifecycle ports)', async () => {
  const f = nativeLifecycleFixture(),
    sessions = { current: accountA as typeof accountA | undefined },
    tokens = tokenStore('kss_same_clear_session');
  const auth = fakeAuth(sessions),
    commandId = '0199c000-0000-7000-8000-000000000104';
  const receipt = { commandId, fromEpoch: 1, toEpoch: 2, recordedAt: '2026-10-23T00:00:00.000Z' };
  const calls: { path: string; claim: string | null; body: unknown }[] = [];
  const manager = createAccountScopeManager({
    baseUrl: 'https://app.scope.test',
    platform: 'native',
    tokens,
    store: memoryStore(),
    durableStorage: f.lifecycle,
    auth,
    fetch: async (request) => {
      const path = new URL(request.url).pathname,
        body: unknown = await request.json();
      calls.push({ path, claim: request.headers.get('x-ks-scope'), body });
      if (path === '/v1/privacy/clear-exploration') {
        sessions.current = { ...accountA, privacyEpoch: 2 };
        return json(202, {
          version: 'clear-exploration.v1',
          ...receipt,
          outcome: 'accepted',
          operation: 'privacy.clear-exploration',
          replayed: false,
        });
      }
      return json(200, {
        version: 'clear-exploration.v1',
        scope: { accountId: accountA.accountId, privacyEpoch: 2 },
        target: { kind: 'command', commandId },
        status: 'completed_live',
        receipt,
      });
    },
  });
  await manager.start();
  const first = manager.getState();
  if (first.status !== 'signed_in') throw new Error('expected old scope');
  let release!: () => void;
  f.holdPurge(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const clearing = manager.privacy.confirm({ commandId, confirmation: 'clear-exploration-preserve-keep-and-social' });
  await vi.waitFor(() => expect(first.scope.active).toBe(false));
  expect(f.prepared).toHaveLength(1);
  expect(manager.getState()).toEqual({ status: 'unavailable' });
  expect(tokens.value).toBe('kss_same_clear_session');
  release();
  expect(await clearing).toBe(true);
  const second = manager.getState();
  if (second.status !== 'signed_in') throw new Error('expected fresh authenticated epoch');
  expect(second.scope.id).toBe(`${accountA.accountId}:2`);
  expect(f.prepared.map((p) => [p.epoch, p.credential])).toEqual([
    [1, 'kss_same_clear_session'],
    [2, 'kss_same_clear_session'],
  ]);
  expect(auth.session).toHaveBeenCalledTimes(2);
  expect(manager.privacy.getState().status).toBe('completed_live');
  expect(second.scope.recording!.getState()).toEqual({ status: 'checking', retryOriginal: false, collecting: false });
  expect(calls).toEqual([
    {
      path: '/v1/privacy/clear-exploration',
      claim: `${accountA.accountId}:1`,
      body: {
        version: 'clear-exploration.v1',
        commandId,
        expectedPrivacyEpoch: 1,
        confirmation: 'clear-exploration-preserve-keep-and-social',
      },
    },
    {
      path: '/v1/privacy/clear-exploration/status',
      claim: `${accountA.accountId}:2`,
      body: { version: 'clear-exploration.v1', target: { kind: 'command', commandId } },
    },
  ]);
  manager.dispose();
});

it('native refresh cannot mount an unconfirmed new credential during or after its failed secure write (CI real auth-client HTTP fixture)', async () => {
  const f = nativeLifecycleFixture(),
    oldToken = `kss_${'a'.repeat(43)}`,
    newToken = `kss_${'b'.repeat(43)}`;
  let failWrite!: (error: Error) => void,
    reads = 0,
    redeemed = false;
  const authorization: (string | null)[] = [];
  const tokens: SessionTokenStore = {
    read: () => Promise.resolve(oldToken),
    write: () =>
      new Promise<void>((_resolve, reject) => {
        failWrite = reject;
      }),
    clear: () => Promise.resolve(),
  };
  const manager = createAccountScopeManager({
    baseUrl: 'https://app.scope.test',
    platform: 'native',
    tokens,
    store: memoryStore(),
    durableStorage: f.lifecycle,
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/auth/redeem') {
        redeemed = true;
        return Promise.resolve(
          json(200, {
            account: accountB,
            accountCreated: false,
            replayed: false,
            session: { kind: 'bearer', token: newToken, expiresAt: '2099-10-23T00:00:00.000Z' },
          }),
        );
      }
      reads++;
      authorization.push(request.headers.get('authorization'));
      // The old credential is no longer accepted after redemption. Only B's token authenticates B.
      if (redeemed && request.headers.get('authorization') !== `Bearer ${newToken}`)
        return Promise.resolve(json(401, {}));
      return Promise.resolve(
        json(200, { account: redeemed ? accountB : accountA, client: 'native', expiresAt: '2099-10-23T00:00:00.000Z' }),
      );
    },
  });
  await manager.start();
  const first = manager.getState();
  if (first.status !== 'signed_in') throw new Error('expected old authenticated scope');
  const redeeming = manager.redeem({
    token: `ksl_${'b'.repeat(43)}`,
    commandId: '0199c000-0000-7000-8000-000000000105',
  });
  await vi.waitFor(() => expect(failWrite).toBeDefined());
  expect(first.scope.active).toBe(false);
  await manager.refresh();
  expect(reads).toBe(1);
  expect(f.prepared).toHaveLength(1);
  failWrite(new Error('secure token commit failed'));
  expect(await redeeming).toEqual({ kind: 'unavailable' });
  expect(manager.getState()).toEqual({ status: 'unavailable' });
  await manager.refresh();
  expect(authorization).toEqual([`Bearer ${oldToken}`, `Bearer ${oldToken}`]);
  expect(f.prepared).toHaveLength(1);
  expect(manager.getState().status).toBe('signed_out');
  manager.dispose();
});

it('an end-entry fence blocks authenticated requests before the existing abort phase (CI transport fixture)', async () => {
  const ended = new AbortController(),
    fetch = vi.fn(() => Promise.resolve(saved(0)));
  const request = fencedFetch({
    fetch,
    ended: ended.signal,
    scope: scopeIdOf(accountA),
    authorization: () => 'Bearer fixture-end-entry',
    isEnding: () => true,
  });
  expect(ended.signal.aborted).toBe(false);
  await expect(request(new Request('https://app.scope.test/v1/saved'))).rejects.toThrow(ScopeEndedError);
  expect(fetch).not.toHaveBeenCalled();
});

it('end-entry is idempotent and finalizes abort/cache/purge even when a native fence and teardown resource throw (CI lifecycle ports)', async () => {
  const base = memoryStore(),
    order: string[] = [],
    requests: Promise<unknown>[] = [];
  let mediaError: unknown, callbackActive: boolean | undefined, receipt: Promise<void> | undefined;
  const fetch = vi.fn(() => Promise.resolve(saved(0))),
    close = vi.fn(() => {
      order.push('socket');
      throw new Error('fixture socket close');
    });
  const purge = vi.fn(() => {
    order.push('purge');
    return Promise.resolve();
  });
  const store: KeyValueStore = {
    ...base,
    durability: {
      flush: () => Promise.resolve(false),
      group: (work) => work(),
      healthy: () => true,
      subscribe: () => () => undefined,
      fence() {
        order.push('fence');
        scope.end();
        throw new Error('fixture native fence');
      },
      purge,
    },
  };
  const connect = vi.fn(() => ({ close }));
  const scope = createAccountScope({
    account: accountA,
    baseUrl: 'https://app.scope.test',
    fetch,
    authorization: () => 'Bearer fixture-end-entry',
    store,
    connect,
  });
  scope.queryClient.setQueryData(scope.queryKey('private'), { label: 'private fixture' });
  scope.storage.set('resume', 'fixture-block');
  scope.onEnd!(() => {
    order.push('first callback');
    callbackActive = scope.active;
    receipt = scope.whenStorageClosed!();
    scope.end();
    requests.push(scope.api.experience.listSaved({}));
    try {
      scope.mediaSource!('/media/fixture');
    } catch (error) {
      mediaError = error;
    }
    scope.reconnect();
    throw new Error('fixture teardown subscriber');
  });
  scope.onEnd!(() => {
    order.push('second callback');
  });
  expect(() => scope.end()).not.toThrow();
  scope.end();
  expect(callbackActive).toBe(true);
  expect(scope.active).toBe(false);
  expect(mediaError).toBeInstanceOf(ScopeEndedError);
  expect(receipt).toBe(scope.whenStorageClosed!());
  await expect(receipt).rejects.toThrow('fixture native fence');
  await expect(requests[0]).rejects.toThrow(ScopeEndedError);
  expect(fetch).not.toHaveBeenCalled();
  expect(connect).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
  expect(purge).toHaveBeenCalledTimes(1);
  expect(order).toEqual(['fence', 'first callback', 'second callback', 'socket', 'purge']);
  expect(scope.queryClient.getQueryCache().getAll()).toEqual([]);
  expect(base.keys()).toEqual([]);
});

it('end-entry drops an in-flight mismatch body before it can start an authenticated session recheck (CI transport fixture)', async () => {
  let release!: () => void,
    ending = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      release = () => {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(problemDetails('SCOPE_MISMATCH'))));
        controller.close();
      };
    },
  });
  const response = new Response(body, { status: 409, headers: { 'content-type': 'application/problem+json' } });
  const clone = vi.spyOn(response, 'clone'),
    onMismatch = vi.fn(),
    ended = new AbortController();
  const fetch = vi.fn(() => Promise.resolve(response));
  const sending = fencedFetch({
    fetch,
    ended: ended.signal,
    scope: scopeIdOf(accountA),
    authorization: () => undefined,
    onMismatch,
    isEnding: () => ending,
  })(new Request('https://app.scope.test/v1/saved'));
  await vi.waitFor(() => expect(clone).toHaveBeenCalledTimes(1));
  ending = true;
  expect(ended.signal.aborted).toBe(false);
  release();
  await expect(sending).rejects.toThrow(ScopeEndedError);
  expect(onMismatch).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(1);
});
