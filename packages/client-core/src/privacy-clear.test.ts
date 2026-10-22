import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  problemDetails,
  type ClearExploration,
  type ClearExplorationStatus,
  type SessionAccount,
} from '@knowscroll/contracts';
import { createAccountScopeManager } from './account-scope-manager';
import { memoryStore, type AccountScope } from './account-scope';
import type { AuthClient, SessionOutcome } from './auth-client';
import { PRIVACY_CLEAR_ACKNOWLEDGEMENT } from './privacy-clear';

// Authored transport fixtures over the actual manager, API decoder and AccountScope fence.
const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const account: SessionAccount = {
  accountId: id(1),
  universeId: id(2),
  privacyEpoch: 1,
  email: 'clear@fixture.invalid',
};
const other = { ...account, accountId: id(9), email: 'other@fixture.invalid' };
const intent = { commandId: id(3), confirmation: PRIVACY_CLEAR_ACKNOWLEDGEMENT };
const receipt = { commandId: id(3), fromEpoch: 1, toEpoch: 2, recordedAt: '2026-10-22T10:00:00.000Z' };
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const respond = (value: unknown, status = 200) => Promise.resolve(json(value, status));
const gate = <T>() => {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};
function signedIn(value: SessionAccount): SessionOutcome {
  return { kind: 'signed_in', account: value, client: 'web', expiresAt: '2026-12-01T00:00:00.000Z' };
}
const managers = new Set<ReturnType<typeof createAccountScopeManager>>();
afterEach(() => {
  for (const manager of managers) manager.dispose();
  managers.clear();
});
async function fixture() {
  let actual = account;
  let sessionGate: Promise<SessionOutcome> | undefined;
  const calls: { path: string; body: unknown; scope: string | null }[] = [];
  let clear: ((body: ClearExploration) => Promise<Response>) | undefined;
  let status: ((body: { target: ClearExplorationStatus['target'] }, epoch: number) => Promise<Response>) | undefined;
  const sessionReads = vi.fn(() => sessionGate ?? Promise.resolve(signedIn(actual)));
  const signOut = vi.fn<AuthClient['signOut']>(() => Promise.resolve('signed_out'));
  const auth: AuthClient = {
    session: sessionReads,
    signOut,
    redeem: vi.fn(() =>
      Promise.resolve({
        kind: 'signed_in' as const,
        response: {
          account: other,
          accountCreated: false,
          replayed: false,
          session: { kind: 'cookie' as const, expiresAt: '2026-12-01T00:00:00.000Z' },
        },
      }),
    ),
    peek: vi.fn(() => Promise.resolve({ kind: 'link_invalid' as const })),
    requestLink: vi.fn(() => Promise.resolve({ kind: 'requested' as const })),
  };
  const store = memoryStore();
  const connections: AccountScope[] = [];
  const manager = createAccountScopeManager({
    baseUrl: 'https://fixture.invalid',
    platform: 'web',
    connect: (scope) => {
      connections.push(scope);
      return { close: () => undefined };
    },
    auth,
    store,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      const body = (await request.json()) as ClearExploration;
      const claim = request.headers.get('x-ks-scope');
      calls.push({ path, body, scope: claim });
      if (path.endsWith('/clear-exploration')) {
        if (clear) return clear(body);
        actual = { ...actual, privacyEpoch: 2 };
        return json({
          version: 'clear-exploration.v1',
          ...receipt,
          outcome: 'accepted',
          operation: 'privacy.clear-exploration',
          replayed: calls.filter((c) => c.path.endsWith('/clear-exploration')).length > 1,
        });
      }
      const target = (body as unknown as { target: ClearExplorationStatus['target'] }).target;
      const epoch = Number(claim?.split(':')[1]);
      if (status) return status({ target }, epoch);
      return json({
        version: 'clear-exploration.v1',
        scope: { accountId: actual.accountId, privacyEpoch: epoch },
        target,
        status: 'pending',
        receipt,
        phase: 'removing_live_data',
      });
    },
  });
  managers.add(manager);
  await manager.start();
  const state = manager.getState();
  if (state.status !== 'signed_in') throw new Error('fixture scope missing');
  const scope = state.scope;
  const current = () => {
    const s = manager.getState();
    return s.status === 'signed_in' ? s.scope : undefined;
  };
  return {
    manager,
    scope,
    store,
    calls,
    sessionReads,
    signOut,
    connections,
    current,
    actual: (value: SessionAccount) => {
      actual = value;
    },
    sessionGate: (value: Promise<SessionOutcome> | undefined) => {
      sessionGate = value;
    },
    clear: (value: typeof clear) => {
      clear = value;
    },
    status: (value: typeof status) => {
      status = value;
    },
  };
}
const clearCalls = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.calls.filter((c) => c.path.endsWith('/clear-exploration'));
const markPrivate = (scope: AccountScope) => {
  scope.storage.set('resume', 'fixture-private-canary');
  scope.queryClient.setQueryData(scope.queryKey('private'), 'fixture-private-canary');
};

describe('manager-owned selective Clear with real client fences', () => {
  it('purges acceptance synchronously before deferred session refresh and never mounts ACK epoch', async () => {
    const f = await fixture();
    const fresh = gate<SessionOutcome>();
    markPrivate(f.scope);
    const ended = vi.fn();
    f.scope.onEnd?.(ended);
    f.sessionGate(fresh.promise);
    const running = f.manager.privacy.confirm(intent);
    await vi.waitFor(() => expect(f.sessionReads).toHaveBeenCalledTimes(2));
    expect(f.scope.active).toBe(false);
    expect(ended).toHaveBeenCalledOnce();
    expect(f.store.keys()).toEqual([]);
    expect(f.scope.queryClient.getQueryCache().getAll()).toEqual([]);
    expect(f.manager.getState().status).toBe('unavailable');
    expect(f.manager.privacy.getState()).toMatchObject({ status: 'accepted', receipt });
    fresh.open(signedIn({ ...account, privacyEpoch: 7 }));
    await running;
    expect(f.current()?.account.privacyEpoch).toBe(7);
    expect(f.manager.privacy.getState().status).toBe('pending');
    expect(f.calls.at(-1)?.scope).toBe(`${account.accountId}:7`);
    f.manager.dispose();
  });

  it('fences unknown outcome before refresh, retains exact body across remount and retries only through current authority', async () => {
    const f = await fixture();
    const fresh = gate<SessionOutcome>();
    markPrivate(f.scope);
    f.clear(() => Promise.reject(new Error('private fixture provider/context must never escape')));
    f.status(({ target }, epoch) =>
      respond({
        version: 'clear-exploration.v1',
        scope: { accountId: account.accountId, privacyEpoch: epoch },
        target,
        status: 'not_recorded',
      }),
    );
    f.sessionGate(fresh.promise);
    const running = f.manager.privacy.confirm(intent);
    await vi.waitFor(() => expect(f.scope.active).toBe(false));
    expect(f.manager.getState().status).toBe('unavailable');
    expect(f.store.keys()).toEqual([]);
    fresh.open(signedIn({ ...account, privacyEpoch: 2 }));
    await running;
    expect(f.manager.privacy.getState()).toMatchObject({ status: 'not_recorded', retryOriginal: true });
    expect(await f.manager.privacy.confirm({ ...intent, commandId: id(4) })).toBe(false);
    await f.manager.privacy.refreshStatus();
    expect(clearCalls(f)).toHaveLength(1);
    f.sessionGate(undefined);
    f.actual({ ...account, privacyEpoch: 2 });
    f.clear(undefined);
    f.status(undefined);
    await f.manager.privacy.retryOriginal();
    const sent = clearCalls(f);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.body).toEqual(sent[0]?.body);
    expect(sent[0]?.body).toEqual({ version: 'clear-exploration.v1', ...intent, expectedPrivacyEpoch: 1 });
    expect(sent[0]?.scope).toBe(`${account.accountId}:1`);
    expect(sent[1]?.scope).toBe(`${account.accountId}:2`);
    expect(f.manager.privacy.getState()).toMatchObject({ status: 'pending', retryOriginal: false });
    expect(JSON.stringify(f.manager.privacy.getState())).not.toContain('private fixture');
    f.manager.dispose();
  });

  it('retains unknown on malformed acceptance and sends only one operation on duplicate confirmation', async () => {
    const f = await fixture();
    const reply = gate<Response>();
    f.clear(() => reply.promise);
    f.status(({ target }, epoch) =>
      respond({
        version: 'clear-exploration.v1',
        scope: { accountId: account.accountId, privacyEpoch: epoch },
        target,
        status: 'not_recorded',
      }),
    );
    const first = f.manager.privacy.confirm(intent);
    expect(await f.manager.privacy.confirm({ ...intent, commandId: id(4) })).toBe(false);
    await vi.waitFor(() => expect(clearCalls(f)).toHaveLength(1));
    reply.open(
      json({
        version: 'clear-exploration.v1',
        ...receipt,
        commandId: id(8),
        outcome: 'accepted',
        operation: 'privacy.clear-exploration',
        replayed: false,
      }),
    );
    await first;
    expect(f.manager.privacy.getState()).toMatchObject({ status: 'not_recorded', retryOriginal: true });
    expect(f.scope.active).toBe(false);
    expect(clearCalls(f)).toHaveLength(1);
    f.manager.dispose();
  });

  it('keeps a same-account scope already refreshed by revocation live and recovers exact command status', async () => {
    const f = await fixture();
    const reply = gate<Response>();
    f.clear(() => reply.promise);
    const running = f.manager.privacy.confirm(intent);
    await vi.waitFor(() => expect(clearCalls(f)).toHaveLength(1));
    f.actual({ ...account, privacyEpoch: 2 });
    await f.manager.refresh();
    const replacement = f.current()!;
    expect(replacement).not.toBe(f.scope);
    expect(f.scope.active).toBe(false);
    reply.open(
      json({
        version: 'clear-exploration.v1',
        ...receipt,
        outcome: 'accepted',
        operation: 'privacy.clear-exploration',
        replayed: false,
      }),
    );
    await running;
    expect(f.current()).toBe(replacement);
    expect(replacement.active).toBe(true);
    expect(f.manager.privacy.getState().status).toBe('pending');
    expect(f.calls.at(-1)).toMatchObject({
      scope: `${account.accountId}:2`,
      body: { target: { kind: 'command', commandId: intent.commandId } },
    });
    f.manager.dispose();
  });

  it.each(['redeem', 'signout', 'dispose'] as const)(
    'ignores a late clear after local %s without touching a newer credential',
    async (action) => {
      const f = await fixture();
      const reply = gate<Response>();
      f.clear(() => reply.promise);
      const running = f.manager.privacy.confirm(intent);
      await vi.waitFor(() => expect(clearCalls(f)).toHaveLength(1));
      if (action === 'redeem') await f.manager.redeem({ token: 'fixture-link', commandId: id(8) });
      if (action === 'signout') await f.manager.signOut();
      if (action === 'dispose') f.manager.dispose();
      const next = f.current();
      const sessionReads = vi.mocked(f.sessionReads).mock.calls.length;
      reply.open(
        json({
          version: 'clear-exploration.v1',
          ...receipt,
          outcome: 'accepted',
          operation: 'privacy.clear-exploration',
          replayed: false,
        }),
      );
      expect(await running).toBe(false);
      expect(f.sessionReads).toHaveBeenCalledTimes(sessionReads);
      expect(f.calls).toHaveLength(1);
      if (action === 'redeem') {
        expect(f.current()).toBe(next);
        expect(next?.active).toBe(true);
        expect(next?.account.accountId).toBe(other.accountId);
      }
      expect(f.manager.privacy.getState().status).toBe(action === 'dispose' ? 'ended' : 'idle');
      expect(await f.manager.privacy.retryOriginal()).toBe(false);
      f.manager.dispose();
    },
  );

  it('does not let a clear recovery session response remount after signout', async () => {
    const f = await fixture();
    const fresh = gate<SessionOutcome>();
    f.sessionGate(fresh.promise);
    const running = f.manager.privacy.confirm(intent);
    await vi.waitFor(() => expect(f.scope.active).toBe(false));
    await f.manager.signOut();
    fresh.open(signedIn({ ...account, privacyEpoch: 2 }));
    expect(await running).toBe(false);
    expect(f.manager.getState().status).toBe('signed_out');
    expect(f.manager.privacy.getState().status).toBe('idle');
    expect(f.calls).toHaveLength(1);
    f.manager.dispose();
  });

  it.each(['account', 'epoch', 'selector'] as const)(
    'rejects a current status with mismatched %s binding',
    async (mismatch) => {
      const f = await fixture();
      f.status(({ target }, epoch) =>
        respond({
          version: 'clear-exploration.v1',
          scope: {
            accountId: mismatch === 'account' ? other.accountId : account.accountId,
            privacyEpoch: mismatch === 'epoch' ? epoch + 1 : epoch,
          },
          target: mismatch === 'selector' ? { kind: 'command', commandId: id(8) } : target,
          status: 'not_recorded',
        }),
      );
      expect(await f.manager.privacy.refreshStatus()).toBe(false);
      expect(f.manager.privacy.getState().status).toBe('unavailable');
      expect(clearCalls(f)).toEqual([]);
      f.manager.dispose();
    },
  );

  it('a reload-like manager reads latest without making an operation and does not invent expiry/completion', async () => {
    const f = await fixture();
    f.actual({ ...account, privacyEpoch: 2 });
    await f.manager.refresh();
    await f.manager.privacy.refreshStatus();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.body).toEqual({ version: 'clear-exploration.v1', target: { kind: 'latest' } });
    expect(f.manager.privacy.getState()).toMatchObject({ status: 'pending', retryOriginal: false, receipt });
    expect(await f.manager.privacy.confirm(intent)).toBe(false);
    expect(clearCalls(f)).toEqual([]);
    f.manager.dispose();
  });

  it('fences a late status read after same-account epoch replacement without leaving a stuck checking state', async () => {
    const f = await fixture();
    const reply = gate<Response>();
    f.status(() => reply.promise);
    const reading = f.manager.privacy.refreshStatus();
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    f.actual({ ...account, privacyEpoch: 2 });
    await f.manager.refresh();
    const replacement = f.current();
    reply.open(
      json({
        version: 'clear-exploration.v1',
        scope: { accountId: account.accountId, privacyEpoch: 1 },
        target: { kind: 'latest' },
        status: 'not_recorded',
      }),
    );
    expect(await reading).toBe(false);
    expect(f.current()).toBe(replacement);
    expect(f.manager.privacy.getState().status).toBe('unavailable');
    f.status(undefined);
    expect(await f.manager.privacy.refreshStatus()).toBe(true);
    expect(f.manager.privacy.getState().status).toBe('pending');
    f.manager.dispose();
  });

  it('a known acceptance cannot be replaced by not_recorded or different receipt metadata', async () => {
    const f = await fixture();
    f.status(({ target }, epoch) =>
      respond({
        version: 'clear-exploration.v1',
        scope: { accountId: account.accountId, privacyEpoch: epoch },
        target,
        status: 'not_recorded',
      }),
    );
    await f.manager.privacy.confirm(intent);
    expect(f.manager.privacy.getState()).toMatchObject({ status: 'unavailable', receipt, retryOriginal: false });
    f.status(({ target }, epoch) =>
      respond({
        version: 'clear-exploration.v1',
        scope: { accountId: account.accountId, privacyEpoch: epoch },
        target,
        status: 'pending',
        receipt: { ...receipt, recordedAt: '2026-10-22T11:00:00.000Z' },
        phase: 'removing_live_data',
      }),
    );
    expect(await f.manager.privacy.refreshStatus()).toBe(false);
    expect(f.manager.privacy.getState()).toMatchObject({ receipt, retryOriginal: false });
    expect(await f.manager.privacy.confirm({ ...intent, commandId: id(4) })).toBe(false);
    f.manager.dispose();
  });
  it('clears old account receipt before a recovery refresh mounts a different account', async () => {
    const f = await fixture();
    const fresh = gate<SessionOutcome>();
    f.sessionGate(fresh.promise);
    const running = f.manager.privacy.confirm(intent);
    await vi.waitFor(() => expect(f.scope.active).toBe(false));
    const observations: string[] = [];
    f.manager.subscribe(() => {
      if (f.current()?.account.accountId === other.accountId) observations.push(f.manager.privacy.getState().status);
    });
    fresh.open(signedIn(other));
    expect(await running).toBe(false);
    expect(observations).toEqual(['idle']);
    expect(f.manager.privacy.getState()).toEqual({ status: 'idle', retryOriginal: false, canConfirm: true });
    expect(f.current()?.account.accountId).toBe(other.accountId);
    expect(f.calls).toHaveLength(1);
  });

  it('does not start or retain a new clear during a local signout transition', async () => {
    const f = await fixture();
    const answer = gate<'signed_out' | 'unavailable'>();
    vi.mocked(f.signOut).mockImplementation(() => answer.promise);
    const signingOut = f.manager.signOut();
    expect(await f.manager.privacy.confirm(intent)).toBe(false);
    expect(clearCalls(f)).toEqual([]);
    answer.open('unavailable');
    await signingOut;
    expect(await f.manager.privacy.confirm(intent)).toBe(true);
    expect(clearCalls(f)).toHaveLength(1);
  });
  it('a failed status refresh cannot unblock a known pending latest receipt into a new command', async () => {
    const f = await fixture();
    f.actual({ ...account, privacyEpoch: 2 });
    await f.manager.refresh();
    await f.manager.privacy.refreshStatus();
    expect(f.manager.privacy.getState()).toMatchObject({ status: 'pending', canConfirm: false });
    f.status(() => Promise.reject(new Error('fixture status unavailable')));
    await f.manager.privacy.refreshStatus();
    expect(f.manager.privacy.getState()).toMatchObject({ status: 'unavailable', canConfirm: false, receipt });
    expect(await f.manager.privacy.confirm(intent)).toBe(false);
    expect(clearCalls(f)).toEqual([]);
  });
  it('dispose during deferred privacy recovery prevents any orphan scope/socket from being created', async () => {
    const f = await fixture();
    const fresh = gate<SessionOutcome>();
    f.sessionGate(fresh.promise);
    const running = f.manager.privacy.confirm(intent);
    await vi.waitFor(() => expect(f.scope.active).toBe(false));
    expect(f.connections).toHaveLength(1);
    f.manager.dispose();
    fresh.open(signedIn({ ...account, privacyEpoch: 2 }));
    expect(await running).toBe(false);
    expect(f.connections).toHaveLength(1);
    expect(f.manager.privacy.getState()).toMatchObject({ status: 'ended', canConfirm: false });
  });
  it('a definitive retry rejection preserves the earlier unknown command until its late receipt is read', async () => {
    const f = await fixture();
    f.actual({ ...account, privacyEpoch: 2 });
    f.clear(() => Promise.reject(new Error('fixture lost first reply')));
    f.status(({ target }, epoch) =>
      respond({
        version: 'clear-exploration.v1',
        scope: { accountId: account.accountId, privacyEpoch: epoch },
        target,
        status: 'not_recorded',
      }),
    );
    await f.manager.privacy.confirm(intent);
    expect(f.manager.privacy.getState()).toMatchObject({ retryOriginal: true, canConfirm: false });
    f.clear(() => respond(problemDetails('UNAUTHENTICATED'), 401));
    await f.manager.privacy.retryOriginal();
    expect(clearCalls(f)).toHaveLength(2);
    expect(clearCalls(f)[1]?.body).toEqual(clearCalls(f)[0]?.body);
    expect(f.manager.privacy.getState()).toMatchObject({
      status: 'not_recorded',
      retryOriginal: true,
      canConfirm: false,
    });
    expect(await f.manager.privacy.confirm({ ...intent, commandId: id(8) })).toBe(false);
    // The first delivery's durable receipt becomes observable later; only that bound read resolves it.
    f.status(undefined);
    expect(await f.manager.privacy.refreshStatus()).toBe(true);
    expect(f.calls.at(-1)?.body).toEqual({
      version: 'clear-exploration.v1',
      target: { kind: 'command', commandId: intent.commandId },
    });
    expect(f.manager.privacy.getState()).toMatchObject({
      status: 'pending',
      receipt,
      retryOriginal: false,
      canConfirm: false,
    });
    expect(await f.manager.privacy.confirm({ ...intent, commandId: id(8) })).toBe(false);
    expect(clearCalls(f)).toHaveLength(2);
  });
});
