import { describe, expect, it, vi } from 'vitest';
import { problemDetails } from '@knowscroll/contracts';
import { createAccountScope, memoryStore } from './account-scope';
import { createFriendsSession } from './friends-session';

// Authored HTTP/state fixtures only. These do not establish actual social journeys.
const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const account = { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'friends@fixture.test' };
const peer = { kind: 'person' as const, personId: id(3), handle: 'fixture.peer', displayName: 'Authored fixture' };
const token = `ksfi_${'s'.repeat(43)}`;
const envelope = { version: 'sharing.v1', scope: { accountId: id(1), privacyEpoch: 1 } };
const lookup = { ...envelope, status: 'available', person: peer, pairRevision: 0 };
function ack(input: Record<string, unknown>, operation = 'friend.request') {
  return {
    ...envelope,
    commandId: input.commandId,
    recordedAt: '2026-10-23T00:00:00.000Z',
    replayed: false,
    outcome: 'accepted',
    operation,
    peerPersonId: input.expectedPeerPersonId ?? input.peerPersonId,
    basePairRevision: input.expectedPairRevision,
    acceptedPairRevision: Number(input.expectedPairRevision) + 1,
  };
}
function inviteAck(input: Record<string, unknown>, replayed = false) {
  return {
    acceptance: {
      ...envelope,
      commandId: input.commandId,
      recordedAt: '2026-10-23T00:00:00.000Z',
      replayed,
      outcome: 'accepted',
      operation: 'invite.create',
      linkId: id(9),
      baseInviteRevision: input.expectedInviteRevision,
      acceptedInviteRevision: Number(input.expectedInviteRevision) + 1,
    },
    delivery: replayed ? { status: 'unavailable' } : { status: 'available', token },
  };
}
function fixture(
  handler: (path: string, input: Record<string, unknown>, signal: AbortSignal) => unknown,
  signedIn = account,
) {
  const calls: { path: string; input: Record<string, unknown>; signal: AbortSignal; body: string }[] = [];
  const store = memoryStore();
  const scope = createAccountScope({
    account: signedIn,
    store,
    authorization: () => undefined,
    baseUrl: 'https://friends.fixture.test',
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      const body = request.method === 'GET' ? '' : await request.text();
      const input = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      calls.push({ path, input, signal: request.signal, body });
      const value = await handler(path, input, request.signal);
      return value instanceof Response
        ? value
        : new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    },
  });
  let sequence = 100;
  const newCommandId = vi.fn(() => id(sequence++));
  return { calls, store, scope, newCommandId, session: createFriendsSession({ scope, newCommandId }) };
}
const draft = () => ({
  expectedPeerPersonId: peer.personId,
  expectedPairRevision: 0,
  target: { kind: 'handle' as const, handle: peer.handle },
});
const stale = () =>
  new Response(JSON.stringify(problemDetails('SHARING_REVISION_STALE')), {
    status: 409,
    headers: { 'content-type': 'application/problem+json' },
  });
const gate = <T>() => {
  let release!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    release = r;
  });
  return { promise, release };
};
async function until(check: () => boolean) {
  for (let n = 0; n < 80 && !check(); n++) await Promise.resolve();
  expect(check()).toBe(true);
}

describe('Friends ephemeral scoped session (authored fixtures)', () => {
  it('requires an actual active scope with synchronous disposal', () => {
    const h = fixture(() => lookup);
    const withoutHook = { ...h.scope };
    delete withoutHook.onEnd;
    expect(() => createFriendsSession({ scope: withoutHook, newCommandId: () => id(9) })).toThrow();
    h.scope.end();
    expect(() => createFriendsSession({ scope: h.scope, newCommandId: () => id(9) })).toThrow();
  });
  it('requires deliberate current lookup/resolve selection and never guesses a peer/ABA handle', async () => {
    const h = fixture(() => lookup);
    await h.session.command('request', draft());
    expect(h.calls).toEqual([]);
    await h.session.lookup(peer.handle);
    await h.session.command('request', { ...draft(), expectedPeerPersonId: id(99) });
    expect(h.calls).toHaveLength(1);
    expect(h.session.getState().command).toMatchObject({ status: 'rejected', reason: 'refresh_required' });
    h.scope.end();
  });
  it('retains exact original body/ID after unknown send, blocks replacement and retries only explicitly', async () => {
    let sends = 0;
    const h = fixture((path, input) =>
      path.endsWith('lookup')
        ? lookup
        : ++sends === 1
          ? Promise.reject(new TypeError('authored network failure'))
          : { ...ack(input), replayed: true },
    );
    await h.session.lookup(peer.handle);
    const original = draft();
    await h.session.command('request', original);
    const first = h.calls[1]!.input;
    expect(h.session.getState().command.status).toBe('unknown');
    original.expectedPeerPersonId = id(99);
    original.target.handle = 'changed';
    await h.session.command('request', draft());
    expect(h.calls).toHaveLength(2);
    expect(h.newCommandId).toHaveBeenCalledTimes(1);
    await h.session.retryCommand();
    expect(h.calls[2]!.input).toEqual(first);
    expect(h.calls[2]!.body).toBe(h.calls[1]!.body);
    expect(h.newCommandId).toHaveBeenCalledTimes(1);
    expect(h.session.getState().command).toMatchObject({ status: 'accepted', acceptance: { replayed: true } });
    expect(h.session.getState().lookup.status).toBe('idle');
    expect(h.session.getState().pair.status).toBe('idle');
    await h.session.retryCommand();
    expect(h.calls).toHaveLength(3);
    h.scope.end();
  });
  it('retains original UUID case in unknown retries while matching the selected semantic peer', async () => {
    let sends = 0;
    const h = fixture((path, input) =>
      path.endsWith('lookup')
        ? lookup
        : ++sends === 1
          ? Promise.reject(new TypeError('authored lost ACK'))
          : { ...ack(input), peerPersonId: peer.personId },
    );
    await h.session.lookup(peer.handle);
    await h.session.command('request', { ...draft(), expectedPeerPersonId: peer.personId.toUpperCase() });
    expect(h.session.getState().command.status).toBe('unknown');
    await h.session.retryCommand();
    expect(h.calls[1]!.input.expectedPeerPersonId).toBe(peer.personId.toUpperCase());
    expect(h.calls[2]!.input).toEqual(h.calls[1]!.input);
    expect(h.calls[2]!.body).toBe(h.calls[1]!.body);
    expect(h.session.getState().command.status).toBe('accepted');
    h.scope.end();
  });
  it('binds a pair request reference across UUID-case aliases without rewriting its command', async () => {
    const h = fixture((path, input) =>
      path.endsWith('pairs/read')
        ? { ...envelope, status: 'available', pair: { state: 'incoming', peer, pairRevision: 2, requestId: id(7) } }
        : { ...ack(input, 'friend.accept'), peerPersonId: peer.personId },
    );
    await h.session.readPair(peer.personId.toUpperCase());
    await h.session.command('accept', {
      peerPersonId: peer.personId.toUpperCase(),
      requestId: id(7).toUpperCase(),
      expectedPairRevision: 2,
    });
    expect(h.calls[1]!.input).toMatchObject({
      peerPersonId: peer.personId.toUpperCase(),
      requestId: id(7).toUpperCase(),
    });
    expect(h.session.getState().command.status).toBe('accepted');
    h.scope.end();
  });
  it('keeps earlier unknown unresolved after a later definitive refusal', async () => {
    let sends = 0;
    const h = fixture((path, input) =>
      path.endsWith('lookup')
        ? lookup
        : ++sends === 1
          ? Promise.reject(new TypeError('fixture'))
          : sends === 2
            ? stale()
            : ack(input),
    );
    await h.session.lookup(peer.handle);
    await h.session.command('request', draft());
    await h.session.retryCommand();
    expect(h.session.getState().command.status).toBe('unknown');
    await h.session.retryCommand();
    expect(h.calls.slice(1).map((c) => c.input)).toEqual([h.calls[1]!.input, h.calls[1]!.input, h.calls[1]!.input]);
    expect(h.session.getState().command.status).toBe('accepted');
    h.scope.end();
  });
  it('clears old pre-ACK reads even when their fetch ignores abort', async () => {
    const delayed = gate<unknown>();
    const h = fixture((path, input) =>
      path.endsWith('lookup') ? lookup : path.endsWith('pairs/read') ? delayed.promise : ack(input),
    );
    await h.session.lookup(peer.handle);
    const old = h.session.readPair(peer.personId);
    await until(() => h.calls.length === 2);
    await h.session.command('request', draft());
    delayed.release({
      ...envelope,
      status: 'available',
      pair: { state: 'outgoing', peer, pairRevision: 1, requestId: id(7) },
    });
    await old;
    expect(h.session.getState().pair.status).toBe('idle');
    expect(h.session.getState().command.status).toBe('accepted');
    h.scope.end();
  });
  it.each(['accept', 'decline', 'cancel', 'remove', 'block', 'unblock'] as const)(
    'binds real %s commands to a current selected pair',
    async (operation) => {
      const state =
        operation === 'accept' || operation === 'decline'
          ? 'incoming'
          : operation === 'cancel'
            ? 'outgoing'
            : operation === 'unblock'
              ? 'blocked'
              : 'friends';
      const pair = {
        state,
        peer,
        pairRevision: 2,
        ...(['incoming', 'outgoing'].includes(state)
          ? { requestId: id(7) }
          : state === 'friends'
            ? { availability: { state: 'unknown' } }
            : {}),
      };
      const h = fixture((path, input) =>
        path.endsWith('pairs/read') ? { ...envelope, status: 'available', pair } : ack(input, `friend.${operation}`),
      );
      await h.session.readPair(peer.personId);
      const input = {
        peerPersonId: peer.personId,
        expectedPairRevision: 2,
        ...(['accept', 'decline', 'cancel'].includes(operation) ? { requestId: id(7) } : {}),
      };
      await h.session.command(operation, input);
      expect(h.calls[1]!.path).toBe(`/v1/social/friends/${operation}`);
      expect(h.session.getState().command.status).toBe('accepted');
      expect(h.session.getState().pair.status).toBe('idle');
      h.scope.end();
    },
  );
  it('refuses mismatched request IDs before any mutation', async () => {
    const h = fixture(() => ({
      ...envelope,
      status: 'available',
      pair: { state: 'incoming', peer, pairRevision: 2, requestId: id(7) },
    }));
    await h.session.readPair(peer.personId);
    await h.session.command('accept', { peerPersonId: peer.personId, expectedPairRevision: 2, requestId: id(99) });
    expect(h.calls).toHaveLength(1);
    h.scope.end();
  });
  it('requires current profile revision and keeps its ACK distinct from a claimed profile', async () => {
    const h = fixture((path, input) =>
      path.endsWith('profile') && !('commandId' in input)
        ? { ...envelope, status: 'unclaimed', profileRevision: 0 }
        : {
            ...envelope,
            commandId: input.commandId,
            recordedAt: '2026-10-23T00:00:00.000Z',
            replayed: false,
            outcome: 'accepted',
            operation: 'profile.set',
            baseProfileRevision: 0,
            acceptedProfileRevision: 1,
          },
    );
    await h.session.readProfile();
    await h.session.command('setProfile', {
      expectedProfileRevision: 1,
      handle: 'fixture.own',
      displayName: 'Fixture',
    });
    expect(h.calls).toHaveLength(1);
    await h.session.command('setProfile', {
      expectedProfileRevision: 0,
      handle: 'fixture.own',
      displayName: 'Fixture',
    });
    expect(h.session.getState().profile.status).toBe('idle');
    expect(h.session.getState().command.status).toBe('accepted');
    h.scope.end();
  });
  it('delivers the first invite secret once in ephemeral memory and nowhere observable/persistent', async () => {
    const h = fixture((path, input) =>
      path.endsWith('/invites') ? { ...envelope, invite: { status: 'none', inviteRevision: 0 } } : inviteAck(input),
    );
    await h.session.readInvites();
    await h.session.command('createInvite', { expectedInviteRevision: 0 });
    expect(h.session.getState().command).toMatchObject({ status: 'accepted', delivery: 'available' });
    expect(JSON.stringify(h.session.getState())).not.toContain(token);
    expect(h.store.keys()).toEqual([]);
    expect(h.scope.queryClient.getQueryCache().getAll()).toEqual([]);
    expect(h.session.takeInviteToken()).toBe(token);
    expect(h.session.takeInviteToken()).toBeUndefined();
    expect(h.session.getState().command).toMatchObject({ delivery: 'unavailable' });
    h.scope.end();
  });
  it('lost first delivery retries the original creation and accepts only delivery unavailable', async () => {
    let creates = 0;
    const h = fixture((path, input) =>
      path.endsWith('/invites')
        ? { ...envelope, invite: { status: 'none', inviteRevision: 0 } }
        : ++creates === 1
          ? Promise.reject(new TypeError('fixture lost response'))
          : inviteAck(input, true),
    );
    await h.session.readInvites();
    await h.session.command('createInvite', { expectedInviteRevision: 0 });
    await h.session.retryCommand();
    expect(h.calls[2]!.input).toEqual(h.calls[1]!.input);
    expect(h.calls[2]!.body).toBe(h.calls[1]!.body);
    expect(h.session.takeInviteToken()).toBeUndefined();
    expect(h.session.getState().command).toMatchObject({
      status: 'accepted',
      delivery: 'unavailable',
      acceptance: { linkId: id(9) },
    });
    h.scope.end();
  });
  it('requires deliberate revoke and fresh current status before another create', async () => {
    let revoked = false;
    const h = fixture((path, input) =>
      path.endsWith('/invites')
        ? {
            ...envelope,
            invite: { status: revoked ? 'revoked' : 'active', linkId: id(9), inviteRevision: revoked ? 2 : 1 },
          }
        : path.endsWith('/revoke')
          ? ((revoked = true),
            {
              ...inviteAck(input).acceptance,
              operation: 'invite.revoke',
              baseInviteRevision: 1,
              acceptedInviteRevision: 2,
            })
          : inviteAck(input),
    );
    await h.session.readInvites();
    await h.session.command('createInvite', { expectedInviteRevision: 1 });
    expect(h.calls).toHaveLength(1);
    await h.session.command('revokeInvite', { linkId: id(9), expectedInviteRevision: 1 });
    expect(h.session.getState().command.status).toBe('accepted');
    await h.session.readInvites();
    await h.session.command('createInvite', { expectedInviteRevision: 2 });
    expect(h.session.getState().command.status).toBe('accepted');
    expect(h.calls.map((c) => c.path)).toEqual([
      '/v1/social/invites',
      '/v1/social/invites/revoke',
      '/v1/social/invites',
      '/v1/social/invites/create',
    ]);
    h.scope.end();
  });
  it('resolves an invite as pure sensitive JSON and binds request to that issuer and exact token', async () => {
    const h = fixture((path, input) =>
      path.endsWith('/resolve') ? { ...envelope, status: 'available', issuer: peer, pairRevision: 0 } : ack(input),
    );
    await h.session.resolveInvite(token);
    await h.session.command('request', { ...draft(), target: { kind: 'invite', token: `ksfi_${'S'.repeat(43)}` } });
    expect(h.calls).toHaveLength(1);
    await h.session.command('request', { ...draft(), target: { kind: 'invite', token } });
    expect(h.calls).toHaveLength(2);
    expect(JSON.stringify(h.session.getState())).not.toContain(token);
    expect(h.calls.every((c) => !c.path.includes(token))).toBe(true);
    h.scope.end();
  });
  it.each(['read', 'command', 'invite'] as const)(
    'scope end synchronously purges %s and fences late success',
    async (kind) => {
      const delayed = gate<unknown>();
      const h = fixture((path) =>
        path.endsWith('lookup')
          ? lookup
          : path.endsWith('/invites')
            ? { ...envelope, invite: { status: 'none', inviteRevision: 0 } }
            : delayed.promise,
      );
      const listener = vi.fn();
      h.session.subscribe(listener);
      let work: Promise<void>;
      if (kind === 'read') work = h.session.readPair(peer.personId);
      else if (kind === 'command') {
        await h.session.lookup(peer.handle);
        work = h.session.command('request', draft());
      } else {
        await h.session.readInvites();
        work = h.session.command('createInvite', { expectedInviteRevision: 0 });
      }
      await until(() => h.calls.some((c) => !c.path.endsWith('/invites') && !c.path.endsWith('lookup')));
      const sent = h.calls[h.calls.length - 1]!.input;
      h.scope.end();
      expect(h.session.getState().status).toBe('ended');
      const notified = listener.mock.calls.length;
      delayed.release(
        kind === 'invite'
          ? inviteAck(sent)
          : kind === 'command'
            ? ack(sent)
            : { ...envelope, status: 'available', pair: { state: 'none', peer, pairRevision: 0 } },
      );
      await work;
      expect(h.session.getState().status).toBe('ended');
      expect(h.session.takeInviteToken()).toBeUndefined();
      expect(listener).toHaveBeenCalledTimes(notified);
      await h.session.retryCommand();
      await h.session.readProfile();
      expect(h.store.keys()).toEqual([]);
      expect(h.scope.queryClient.getQueryCache().getAll()).toEqual([]);
    },
  );
  it('keeps scope objects independent even for identical account/epoch IDs', async () => {
    const a = fixture(() => lookup),
      b = fixture(() => lookup);
    await a.session.lookup(peer.handle);
    a.scope.end();
    expect(b.session.getState().status).toBe('active');
    expect(b.session.getState().lookup.status).toBe('idle');
    await b.session.lookup(peer.handle);
    expect(b.session.getState().lookup.status).toBe('ready');
    b.scope.end();
  });
  it('cannot repopulate a newer account/epoch with an old successful response', async () => {
    const delayed = gate<unknown>();
    const old = fixture(() => delayed.promise);
    const work = old.session.lookup(peer.handle);
    await until(() => old.calls.length === 1);
    old.scope.end();
    const signedIn = { ...account, accountId: id(40), privacyEpoch: 2 };
    const current = fixture(() => ({ ...lookup, scope: { accountId: signedIn.accountId, privacyEpoch: 2 } }), signedIn);
    await current.session.lookup(peer.handle);
    const before = current.session.getState();
    delayed.release(lookup);
    await work;
    expect(old.session.getState().status).toBe('ended');
    expect(current.session.getState()).toBe(before);
    expect(current.session.getState().lookup.status).toBe('ready');
    expect(current.scope.queryClient.getQueryCache().getAll()).toEqual([]);
    current.scope.end();
  });
  it('a subscriber disposing during loading prevents subsequent fetch/old notifications', async () => {
    const h = fixture(() => lookup);
    const seen: string[] = [];
    h.session.subscribe(() => {
      if (h.session.getState().lookup.status === 'loading') h.session.dispose();
    });
    h.session.subscribe(() => {
      seen.push(h.session.getState().status);
    });
    await h.session.lookup(peer.handle);
    expect(h.calls).toEqual([]);
    expect(seen).toEqual(['ended']);
    expect(h.session.getState().status).toBe('ended');
    h.scope.end();
  });
  it('bounds abort-ignoring reads to one in flight and one latest queued selection', async () => {
    const delayed = gate<unknown>();
    const h = fixture((_path, input) =>
      input.handle === 'first' ? delayed.promise : { ...lookup, person: { ...peer, handle: input.handle } },
    );
    const first = h.session.lookup('first');
    await until(() => h.calls.length === 1);
    const middle = h.session.lookup('middle');
    const last = h.session.lookup('last');
    await middle;
    expect(h.calls).toHaveLength(1);
    delayed.release({ ...lookup, person: { ...peer, handle: 'first' } });
    await first;
    await last;
    expect(h.calls.map((c) => c.input.handle)).toEqual(['first', 'last']);
    expect(h.session.getState().lookup).toMatchObject({ status: 'ready', data: { person: { handle: 'last' } } });
    h.scope.end();
  });
  it('retains the newest reentrant loading selection while an abort-ignoring read is held', async () => {
    const delayed = gate<unknown>();
    const h = fixture((_path, input) =>
      input.handle === 'first' ? delayed.promise : { ...lookup, person: { ...peer, handle: input.handle } },
    );
    const first = h.session.lookup('first');
    await until(() => h.calls.length === 1);
    let selected = false;
    let latest: Promise<void> | undefined;
    h.session.subscribe(() => {
      if (!selected && h.session.getState().lookup.status === 'loading') {
        selected = true;
        latest = h.session.lookup('last');
      }
    });
    await h.session.lookup('middle');
    expect(selected).toBe(true);
    expect(h.calls).toHaveLength(1);
    delayed.release({ ...lookup, person: { ...peer, handle: 'first' } });
    await first;
    await latest;
    expect(h.calls.map((c) => c.input.handle)).toEqual(['first', 'last']);
    expect(h.session.getState().lookup).toMatchObject({ status: 'ready', data: { person: { handle: 'last' } } });
    h.scope.end();
  });
  it('does not publish an obsolete outer read after transport-abort reentrancy selects a newer read', async () => {
    const delayed = gate<unknown>();
    let latest: Promise<void> | undefined;
    const h = fixture((_path, input, signal) => {
      if (input.handle === 'first') {
        signal.addEventListener(
          'abort',
          () => {
            latest = h.session.lookup('last');
          },
          { once: true },
        );
        return delayed.promise;
      }
      return { ...lookup, person: { ...peer, handle: input.handle } };
    });
    const first = h.session.lookup('first');
    await until(() => h.calls.length === 1);
    const profileStates: string[] = [];
    h.session.subscribe(() => {
      profileStates.push(h.session.getState().profile.status);
    });
    await h.session.readProfile();
    expect(latest).toBeDefined();
    expect(profileStates).not.toContain('loading');
    expect(h.calls).toHaveLength(1);
    delayed.release({ ...lookup, person: { ...peer, handle: 'first' } });
    await first;
    await latest;
    expect(h.calls.map((c) => c.input.handle)).toEqual(['first', 'last']);
    expect(h.session.getState().lookup).toMatchObject({ status: 'ready', data: { person: { handle: 'last' } } });
    h.scope.end();
  });
  it('purges every resource and secret on authoritative refusal and survives a throwing subscriber', async () => {
    const h = fixture(
      () =>
        new Response(JSON.stringify(problemDetails('SCOPE_MISMATCH')), {
          status: 409,
          headers: { 'content-type': 'application/problem+json' },
        }),
    );
    h.session.subscribe(() => {
      throw new Error('authored consumer failure');
    });
    await h.session.readProfile();
    expect(h.session.getState().status).toBe('ended');
    h.scope.end();
  });
});

function scanPage(input: Record<string, unknown>, items: unknown[] = [], next?: string) {
  return {
    version: 'friend-pages.v2',
    requestId: input.requestId,
    scope: envelope.scope,
    filter: input.filter,
    snapshotRevision: 7,
    items,
    ...(next ? { next: { scope: envelope.scope, filter: input.filter, snapshotRevision: 7, token: next } } : {}),
  };
}
function scanPair(filter: unknown, n = 0) {
  return {
    state: filter,
    peer: { ...peer, personId: id(200 + n) },
    pairRevision: 2,
    ...(filter === 'friends'
      ? { availability: { state: 'unknown' } }
      : filter === 'incoming' || filter === 'outgoing'
        ? { requestId: id(7) }
        : {}),
  };
}
describe('Friends v2 roster recovery session (authored fixtures)', () => {
  it('keeps empty scan continuations recoverable and performs one read per explicit Next', async () => {
    const h = fixture((_path, input) => {
      const cursor = input.cursor as { token: string } | undefined;
      return cursor?.token === 'scan_2'
        ? scanPage(input, [scanPair(input.filter)])
        : scanPage(input, [], cursor ? 'scan_2' : 'scan_1');
    });
    await h.session.refreshPage();
    expect(h.session.getState().roster).toMatchObject({
      status: 'ready',
      data: { items: [], next: { token: 'scan_1' } },
    });
    expect(h.session.getState().canNext).toBe(true);
    expect(h.calls).toHaveLength(1);
    await h.session.nextPage();
    expect(h.session.getState().canNext).toBe(true);
    expect(h.calls).toHaveLength(2);
    await h.session.nextPage();
    expect(h.session.getState().roster).toMatchObject({ status: 'ready', data: { items: [scanPair('friends')] } });
    expect(h.session.getState().canNext).toBe(false);
    await h.session.nextPage();
    expect(h.calls).toHaveLength(3);
    expect(new Set(h.calls.map((c) => c.input.requestId)).size).toBe(3);
    expect(h.calls.every((c) => c.path === '/v1/social/friends/page')).toBe(true);
    h.scope.end();
  });
  it.each(['friends', 'incoming', 'outgoing', 'blocked'] as const)(
    'reads real %s pages without fake people or mutation',
    async (filter) => {
      const h = fixture((_path, input) => scanPage(input, [scanPair(input.filter)]));
      await h.session.selectFilter(filter);
      expect(h.session.getState().filter).toBe(filter);
      expect(h.session.getState().roster).toMatchObject({
        status: 'ready',
        data: { filter, items: [scanPair(filter)] },
      });
      expect(h.calls[0]!.path).toBe(
        `/v1/social/${filter === 'friends' || filter === 'blocked' ? 'friends' : 'requests'}/page`,
      );
      expect(h.calls[0]!.input).toMatchObject({ version: 'friend-pages.v2', limit: 50, filter });
      expect(h.session.getState().command.status).toBe('idle');
      expect(h.session.takeInviteToken()).toBeUndefined();
      h.scope.end();
    },
  );
  it('retains at most fifty current rows and refuses an oversized next page without trimming', async () => {
    const h = fixture((_path, input) =>
      scanPage(
        input,
        Array.from({ length: input.cursor ? 51 : 50 }, (_, n) => scanPair(input.filter, n)),
        input.cursor ? undefined : 'next_fifty',
      ),
    );
    await h.session.refreshPage();
    const first = h.session.getState().roster;
    expect(first.status === 'ready' && first.data.items.length).toBe(50);
    await h.session.nextPage();
    expect(h.session.getState().roster).toEqual({ status: 'unavailable', reason: 'invalid' });
    expect(h.session.getState().canNext).toBe(false);
    expect(h.calls).toHaveLength(2);
    expect(h.scope.queryClient.getQueryCache().getAll()).toEqual([]);
    h.scope.end();
  });
  it('retains only eight previous page-start cursors and no previous page bodies', async () => {
    const h = fixture((_path, input) => {
      const value = input.cursor as { token: string } | undefined;
      const index = value ? Number(value.token.slice(2)) : 0;
      return scanPage(input, [scanPair(input.filter, index)], `p_${index + 1}`);
    });
    await h.session.refreshPage();
    for (let n = 0; n < 10; n++) await h.session.nextPage();
    expect(h.session.getState().roster).toMatchObject({ status: 'ready', data: { items: [scanPair('friends', 10)] } });
    expect(JSON.stringify(h.session.getState())).not.toContain(id(209));
    for (let n = 0; n < 8; n++) {
      expect(h.session.getState().canPrevious).toBe(true);
      await h.session.previousPage();
    }
    expect(h.session.getState().canPrevious).toBe(false);
    expect(h.session.getState().roster).toMatchObject({ status: 'ready', data: { items: [scanPair('friends', 2)] } });
    const before = h.calls.length;
    await h.session.previousPage();
    expect(h.calls).toHaveLength(before);
    await h.session.refreshPage();
    expect(h.calls[h.calls.length - 1]!.input).not.toHaveProperty('cursor');
    expect(h.session.getState().roster).toMatchObject({ status: 'ready', data: { items: [scanPair('friends', 0)] } });
    expect(h.scope.queryClient.getQueryCache().getAll()).toEqual([]);
    expect(h.store.keys()).toEqual([]);
    h.scope.end();
  });
  it('stale continuation requires explicit Refresh and never claims an empty terminal roster', async () => {
    const h = fixture((_path, input) =>
      input.cursor ? stale() : scanPage(input, [scanPair(input.filter)], 'old_cursor'),
    );
    await h.session.refreshPage();
    await h.session.nextPage();
    expect(h.calls).toHaveLength(2);
    expect(h.session.getState().roster).toEqual({ status: 'unavailable', reason: 'refresh_required' });
    expect(h.session.getState().canNext).toBe(false);
    expect(h.session.getState().canPrevious).toBe(false);
    await h.session.nextPage();
    expect(h.calls).toHaveLength(2);
    await h.session.refreshPage();
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2]!.input).not.toHaveProperty('cursor');
    expect(h.calls[2]!.input.requestId).not.toBe(h.calls[1]!.input.requestId);
    h.scope.end();
  });
  it('rejects a continuation loop through a retained token with explicit Refresh recovery', async () => {
    const h = fixture((_path, input) => {
      const value = input.cursor as { token: string } | undefined;
      return scanPage(input, [], !value ? 'a' : value.token === 'a' ? 'b' : 'a');
    });
    await h.session.refreshPage();
    await h.session.nextPage();
    await h.session.nextPage();
    expect(h.calls).toHaveLength(3);
    expect(h.session.getState().roster).toEqual({ status: 'unavailable', reason: 'invalid' });
    expect(h.session.getState().canNext).toBe(false);
    await h.session.refreshPage();
    expect(h.calls).toHaveLength(4);
    expect(h.calls[3]!.input).not.toHaveProperty('cursor');
    h.scope.end();
  });
  it('switching filters drops old cursor authority and fences a late abort-ignoring page', async () => {
    const delayed = gate<unknown>();
    const h = fixture((_path, input) =>
      input.filter === 'friends' ? delayed.promise : scanPage(input, [scanPair(input.filter)]),
    );
    const first = h.session.refreshPage();
    await until(() => h.calls.length === 1);
    const blocked = h.session.selectFilter('blocked');
    expect(h.calls).toHaveLength(1);
    delayed.release(scanPage(h.calls[0]!.input, [scanPair('friends')], 'old_friends'));
    await first;
    await blocked;
    expect(h.session.getState().filter).toBe('blocked');
    expect(h.session.getState().roster).toMatchObject({
      status: 'ready',
      data: { filter: 'blocked', items: [scanPair('blocked')] },
    });
    expect(h.calls[1]!.input).not.toHaveProperty('cursor');
    expect(h.session.getState().canPrevious).toBe(false);
    h.scope.end();
  });
  it('late page success cannot repopulate a new account/epoch or restore cursor history', async () => {
    const delayed = gate<unknown>();
    const old = fixture((_path, input) => (input.cursor ? delayed.promise : scanPage(input, [], 'old_next')));
    await old.session.refreshPage();
    const work = old.session.nextPage();
    await until(() => old.calls.length === 2);
    old.scope.end();
    const signedIn = { ...account, accountId: id(60), privacyEpoch: 2 };
    const current = fixture(
      (_path, input) => ({ ...scanPage(input), scope: { accountId: signedIn.accountId, privacyEpoch: 2 } }),
      signedIn,
    );
    await current.session.refreshPage();
    const before = current.session.getState();
    delayed.release(scanPage(old.calls[1]!.input, [scanPair('friends')], 'later_old'));
    await work;
    expect(old.session.getState()).toMatchObject({
      status: 'ended',
      canPrevious: false,
      canNext: false,
      roster: { status: 'idle' },
    });
    expect(current.session.getState()).toBe(before);
    expect(current.session.getState().canPrevious).toBe(false);
    expect(current.scope.queryClient.getQueryCache().getAll()).toEqual([]);
    current.scope.end();
  });
  it('a newer current list head never invalidates the original unknown command ACK replay', async () => {
    let sends = 0;
    const h = fixture((path, input) =>
      path.endsWith('/lookup')
        ? lookup
        : path.endsWith('/page')
          ? { ...scanPage(input), snapshotRevision: 90 }
          : ++sends === 1
            ? Promise.reject(new TypeError('authored lost ACK'))
            : { ...ack(input), replayed: true },
    );
    await h.session.lookup(peer.handle);
    await h.session.command('request', draft());
    const original = h.calls[1]!.input;
    await h.session.refreshPage();
    expect(h.session.getState().roster).toMatchObject({ status: 'ready', data: { snapshotRevision: 90 } });
    await h.session.retryCommand();
    expect(h.calls[3]!.input).toEqual(original);
    expect(h.newCommandId).toHaveBeenCalledTimes(2); // One command plus one pure read correlation.
    expect(h.session.getState().command).toMatchObject({
      status: 'accepted',
      acceptance: { basePairRevision: 0, acceptedPairRevision: 1, replayed: true },
    });
    expect(h.session.getState().roster.status).toBe('idle');
    h.scope.end();
  });
});
