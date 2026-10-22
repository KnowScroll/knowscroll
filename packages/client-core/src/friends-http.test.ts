import { describe, expect, it } from 'vitest';
import { problemDetails } from '@knowscroll/contracts';
import { createAccountScope, memoryStore } from './account-scope';
import { createFriendsHttp, FriendsHttpError } from './friends-http';
import type { FriendsInput, FriendsOperation } from './friends-types';

// Authored HTTP protocol fixtures. No real person, friendship, invite or social activity.
const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const account = { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'friends@fixture.test' };
const scopeValue = { accountId: account.accountId, privacyEpoch: 1 };
const peer = { kind: 'person' as const, personId: id(3), handle: 'fixture-peer', displayName: 'Authored fixture' };
const token = `ksfi_${'x'.repeat(43)}`;
const envelope = { version: 'sharing.v1' as const, scope: scopeValue };
const acceptance = {
  ...envelope,
  commandId: id(8),
  recordedAt: '2026-10-23T00:00:00.000Z',
  replayed: false,
  outcome: 'accepted',
};
const pair = { state: 'friends', peer, pairRevision: 2, availability: { state: 'unknown' } };
const command = { version: 'sharing.v1', commandId: id(8), peerPersonId: peer.personId, expectedPairRevision: 2 };
function fixture(handler: (request: Request, input: Record<string, unknown>) => unknown) {
  const calls: { path: string; method: string; input: Record<string, unknown>; scope: string | null }[] = [];
  const store = memoryStore();
  const scope = createAccountScope({
    account,
    store,
    authorization: () => undefined,
    baseUrl: 'https://friends.fixture.test',
    fetch: async (request) => {
      const input = request.method === 'GET' ? {} : ((await request.json()) as Record<string, unknown>);
      calls.push({
        path: new URL(request.url).pathname,
        method: request.method,
        input,
        scope: request.headers.get('X-KS-Scope'),
      });
      const result = await handler(request, input);
      return result instanceof Response
        ? result
        : new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
    },
  });
  return { scope, store, calls, http: createFriendsHttp(scope) };
}
const cases: { operation: FriendsOperation; path: string; input: unknown; output: unknown }[] = [
  {
    operation: 'profile',
    path: 'profile',
    input: {},
    output: { ...envelope, status: 'unclaimed', profileRevision: 0 },
  },
  {
    operation: 'setProfile',
    path: 'profile',
    input: {
      version: 'sharing.v1',
      commandId: id(8),
      expectedProfileRevision: 0,
      handle: 'fixture-own',
      displayName: 'Fixture',
    },
    output: { ...acceptance, operation: 'profile.set', baseProfileRevision: 0, acceptedProfileRevision: 1 },
  },
  {
    operation: 'lookup',
    path: 'people/lookup',
    input: { version: 'sharing.v1', handle: peer.handle },
    output: { ...envelope, status: 'available', person: peer, pairRevision: 0 },
  },
  {
    operation: 'pair',
    path: 'pairs/read',
    input: { version: 'sharing.v1', peerPersonId: peer.personId },
    output: { ...envelope, status: 'available', pair },
  },
  ...(['request', 'accept', 'decline', 'cancel', 'remove', 'block', 'unblock'] as const).map((operation) => ({
    operation,
    path: `friends/${operation}`,
    input:
      operation === 'request'
        ? {
            version: 'sharing.v1',
            commandId: id(8),
            expectedPeerPersonId: peer.personId,
            expectedPairRevision: 2,
            target: { kind: 'handle', handle: peer.handle },
          }
        : ['accept', 'decline', 'cancel'].includes(operation)
          ? { ...command, requestId: id(7) }
          : command,
    output: {
      ...acceptance,
      operation: `friend.${operation}`,
      peerPersonId: peer.personId,
      basePairRevision: 2,
      acceptedPairRevision: 3,
    },
  })),
  {
    operation: 'invites',
    path: 'invites',
    input: {},
    output: { ...envelope, invite: { status: 'none', inviteRevision: 0 } },
  },
  {
    operation: 'createInvite',
    path: 'invites/create',
    input: { version: 'sharing.v1', commandId: id(8), expectedInviteRevision: 0 },
    output: {
      acceptance: {
        ...acceptance,
        operation: 'invite.create',
        linkId: id(9),
        baseInviteRevision: 0,
        acceptedInviteRevision: 1,
      },
      delivery: { status: 'available', token },
    },
  },
  {
    operation: 'revokeInvite',
    path: 'invites/revoke',
    input: { version: 'sharing.v1', commandId: id(8), expectedInviteRevision: 1, linkId: id(9) },
    output: {
      ...acceptance,
      operation: 'invite.revoke',
      linkId: id(9),
      baseInviteRevision: 1,
      acceptedInviteRevision: 2,
    },
  },
  {
    operation: 'resolveInvite',
    path: 'invites/resolve',
    input: { version: 'sharing.v1', token },
    output: { ...envelope, status: 'available', issuer: peer, pairRevision: 0 },
  },
];
describe('Friends scoped HTTP transport (authored fixtures)', () => {
  it.each(cases)('uses actual $operation wire route, schema and scope', async ({ operation, path, input, output }) => {
    const h = fixture(() => output);
    const reply = await h.http.call(operation, input as FriendsInput<typeof operation>);
    expect(reply).toEqual(output);
    expect(Object.isFrozen(reply)).toBe(true);
    expect(h.calls).toEqual([
      {
        path: `/v1/social/${path}`,
        method: operation === 'profile' || operation === 'invites' ? 'GET' : 'POST',
        input,
        scope: `${account.accountId}:1`,
      },
    ]);
    expect(h.calls[0]!.path).not.toContain(token);
    expect(h.scope.queryClient.getQueryCache().getAll()).toEqual([]);
    expect(h.store.keys()).toEqual([]);
    h.scope.end();
  });
  it.each(['scope', 'epoch', 'commandId', 'operation', 'peer', 'base'])(
    'refuses a valid-looking wrong %s ACK as ambiguous',
    async (field) => {
      const value = {
        ...acceptance,
        operation: 'friend.remove',
        peerPersonId: peer.personId,
        basePairRevision: 2,
        acceptedPairRevision: 3,
      };
      if (field === 'scope') value.scope = { ...scopeValue, accountId: id(99) };
      if (field === 'epoch') value.scope = { ...scopeValue, privacyEpoch: 2 };
      if (field === 'commandId') value.commandId = id(99);
      if (field === 'operation') value.operation = 'friend.block';
      if (field === 'peer') value.peerPersonId = id(99);
      if (field === 'base') value.basePairRevision = 1;
      const h = fixture(() => value);
      await expect(h.http.call('remove', command as FriendsInput<'remove'>)).rejects.toMatchObject({
        reason: 'invalid',
        ambiguous: true,
      });
      h.scope.end();
    },
  );
  it('binds lookup handles, pair public identity and revoke link references', async () => {
    const h = fixture((request) =>
      new URL(request.url).pathname.endsWith('lookup')
        ? { ...envelope, status: 'available', person: { ...peer, handle: 'wrong-handle' }, pairRevision: 0 }
        : new URL(request.url).pathname.endsWith('read')
          ? { ...envelope, status: 'available', pair: { ...pair, peer: { ...peer, personId: id(99) } } }
          : {
              ...acceptance,
              operation: 'invite.revoke',
              linkId: id(99),
              baseInviteRevision: 1,
              acceptedInviteRevision: 2,
            },
    );
    await expect(h.http.call('lookup', { version: 'sharing.v1', handle: peer.handle })).rejects.toBeInstanceOf(
      FriendsHttpError,
    );
    await expect(h.http.call('pair', { version: 'sharing.v1', peerPersonId: peer.personId })).rejects.toBeInstanceOf(
      FriendsHttpError,
    );
    await expect(
      h.http.call('revokeInvite', {
        version: 'sharing.v1',
        commandId: id(8),
        linkId: id(9),
        expectedInviteRevision: 1,
      }),
    ).rejects.toBeInstanceOf(FriendsHttpError);
    h.scope.end();
  });
  it('never accepts replayed invite secret delivery', async () => {
    const entry = cases.find((c) => c.operation === 'createInvite')!;
    const h = fixture(() => ({
      ...(entry.output as object),
      acceptance: {
        ...acceptance,
        operation: 'invite.create',
        replayed: true,
        linkId: id(9),
        baseInviteRevision: 0,
        acceptedInviteRevision: 1,
      },
    }));
    await expect(h.http.call('createInvite', entry.input as FriendsInput<'createInvite'>)).rejects.toMatchObject({
      reason: 'invalid',
      ambiguous: true,
    });
    h.scope.end();
  });
  it('does not send malformed input or any request after scope end', async () => {
    const h = fixture(() => {
      throw new Error('must not run');
    });
    await expect(h.http.call('lookup', { version: 'sharing.v1', handle: ' INVALID ' })).rejects.toMatchObject({
      ambiguous: false,
    });
    h.scope.end();
    await expect(h.http.call('profile', {})).rejects.toMatchObject({ reason: 'authority' });
    expect(h.calls).toEqual([]);
  });
  it('classifies definitive stale/CAS failure without retaining private problem extensions', async () => {
    const h = fixture(
      () =>
        new Response(JSON.stringify({ ...problemDetails('SHARING_REVISION_STALE'), secretPeerReason: token }), {
          status: 409,
          headers: { 'content-type': 'application/problem+json' },
        }),
    );
    await expect(h.http.call('remove', command as FriendsInput<'remove'>)).rejects.toMatchObject({
      reason: 'refresh_required',
      ambiguous: false,
    });
    try {
      await h.http.call('remove', command as FriendsInput<'remove'>);
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(token);
    }
    h.scope.end();
  });
  it('bounds accepted decoded bytes and rejects unknown/private output properties', async () => {
    const h = fixture(() => ({ ...envelope, status: 'unavailable', privatePeerRoot: 'x'.repeat(65536) }));
    await expect(h.http.call('lookup', { version: 'sharing.v1', handle: peer.handle })).rejects.toMatchObject({
      reason: 'invalid',
    });
    h.scope.end();
  });
});
