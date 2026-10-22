import 'reflect-metadata';
import { call } from '@orpc/server';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { FriendOperation, SocialUseCases } from '@knowscroll/backend/modules/social';
import { SocialController } from './social.controller.js';
import { scopeGuard } from './scope-guard.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const accountId = id(1),
  universeId = id(2),
  commandId = id(3),
  peerPersonId = id(4);
const scope = { accountId, privacyEpoch: 2 };
const authority = { universeId, privacyEpoch: 2, actor: { kind: 'account' as const, accountId } };
const person = { kind: 'person' as const, personId: peerPersonId, handle: 'friend.a', displayName: '友人' };
const envelope = { version: 'sharing.v1' as const, scope };
const acceptance = {
  ...envelope,
  commandId,
  recordedAt: '2026-10-22T00:00:00.000Z',
  replayed: false,
  outcome: 'accepted' as const,
};
async function admitted() {
  const request = { path: '/v1/social/profile', headers: { 'x-ks-scope': `${accountId}:2` } } as unknown as Request;
  const next = vi.fn();
  await scopeGuard({
    callers: {
      resolve: () => Promise.resolve({ ...scope, universeId, sessionId: id(5), credential: 'bearer' }),
      sessionValid: () => Promise.resolve(true),
    },
    logEvent: () => undefined,
  })(request, {} as Response, next);
  expect(next).toHaveBeenCalledOnce();
  return request;
}
function fixture() {
  const readProfile = vi.fn<SocialUseCases['readProfile']>(() =>
    Promise.resolve({ kind: 'ok', value: { ...envelope, status: 'unclaimed', profileRevision: 0 } }),
  );
  const setProfile = vi.fn<SocialUseCases['setProfile']>(() =>
    Promise.resolve({
      kind: 'ok',
      value: { ...acceptance, operation: 'profile.set', baseProfileRevision: 0, acceptedProfileRevision: 1 },
    }),
  );
  const lookup = vi.fn<SocialUseCases['lookup']>(() =>
    Promise.resolve({ kind: 'ok', value: { ...envelope, status: 'available', person, pairRevision: 0 } }),
  );
  const readPair = vi.fn<SocialUseCases['readPair']>(() =>
    Promise.resolve({
      kind: 'ok',
      value: { ...envelope, status: 'available', pair: { state: 'none', peer: person, pairRevision: 0 } },
    }),
  );
  const command = vi.fn<SocialUseCases['command']>((_authority, operation) =>
    Promise.resolve({
      kind: 'ok',
      value: {
        ...acceptance,
        operation: `friend.${operation}`,
        peerPersonId,
        basePairRevision: 1,
        acceptedPairRevision: 2,
      },
    }),
  );
  return {
    readProfile,
    setProfile,
    lookup,
    readPair,
    command,
    controller: new SocialController({ readProfile, setProfile, lookup, readPair, command }),
  };
}
const commandBase = { version: 'sharing.v1' as const, commandId, expectedPairRevision: 1, peerPersonId };
const commands = {
  request: {
    version: 'sharing.v1' as const,
    commandId,
    expectedPairRevision: 1,
    expectedPeerPersonId: peerPersonId,
    target: { kind: 'handle' as const, handle: person.handle },
  },
  accept: { ...commandBase, requestId: id(6) },
  decline: { ...commandBase, requestId: id(6) },
  cancel: { ...commandBase, requestId: id(6) },
  remove: commandBase,
  block: commandBase,
  unblock: commandBase,
};
function command<O extends FriendOperation>(operation: O) {
  return commands[operation];
}

const profile = {
  version: 'sharing.v1' as const,
  commandId,
  expectedProfileRevision: 0,
  handle: 'self.a',
  displayName: 'Self',
};

describe('Social thin adapters (authored transport fixtures, no mounted-runtime claim)', () => {
  it('passes actual guard-admitted authority and unchanged profile/lookup/pair selectors only', async () => {
    const f = fixture(),
      request = await admitted();
    expect(await call(f.controller.profileRoute(request), {})).toEqual({
      ...envelope,
      status: 'unclaimed',
      profileRevision: 0,
    });
    await call(f.controller.setProfileRoute(request), profile);
    const lookup = { version: 'sharing.v1' as const, handle: person.handle };
    await call(f.controller.lookupRoute(request), lookup);
    const pair = { version: 'sharing.v1' as const, peerPersonId };
    await call(f.controller.pairRoute(request), pair);
    expect(f.readProfile).toHaveBeenCalledExactlyOnceWith(authority);
    expect(f.setProfile).toHaveBeenCalledExactlyOnceWith(authority, profile);
    expect(f.lookup).toHaveBeenCalledExactlyOnceWith(authority, lookup);
    expect(f.readPair).toHaveBeenCalledExactlyOnceWith(authority, pair);
    expect(f.command).not.toHaveBeenCalled();
  });
  it.each(['request', 'accept', 'decline', 'cancel', 'remove', 'block', 'unblock'] as const)(
    'maps exactly the deliberate %s command without a generic invitation/list fallback',
    async (operation) => {
      const f = fixture(),
        request = await admitted(),
        input = command(operation);
      const invoke = {
        request: () => call(f.controller.requestRoute(request), command('request')),
        accept: () => call(f.controller.acceptRoute(request), command('accept')),
        decline: () => call(f.controller.declineRoute(request), command('decline')),
        cancel: () => call(f.controller.cancelRoute(request), command('cancel')),
        remove: () => call(f.controller.removeRoute(request), command('remove')),
        block: () => call(f.controller.blockRoute(request), command('block')),
        unblock: () => call(f.controller.unblockRoute(request), command('unblock')),
      }[operation];
      expect(await invoke()).toMatchObject({ commandId, operation: `friend.${operation}`, peerPersonId, scope });
      expect(f.command).toHaveBeenCalledExactlyOnceWith(authority, operation, input);
      expect(f.lookup).not.toHaveBeenCalled();
      expect(f.readPair).not.toHaveBeenCalled();
    },
  );
  it('does not manufacture current state when returning an admitted historical acceptance', async () => {
    const f = fixture();
    f.command.mockResolvedValue({
      kind: 'ok',
      value: {
        ...acceptance,
        replayed: true,
        operation: 'friend.accept',
        peerPersonId,
        basePairRevision: 1,
        acceptedPairRevision: 2,
      },
    });
    expect(await call(f.controller.acceptRoute(await admitted()), command('accept'))).toMatchObject({
      replayed: true,
      operation: 'friend.accept',
    });
    expect(f.readPair).not.toHaveBeenCalled();
  });
  it('refuses wrong caller scope, command, operation, selected peer and private output keys', async () => {
    const accepted = {
      ...acceptance,
      operation: 'friend.block' as const,
      peerPersonId,
      basePairRevision: 1,
      acceptedPairRevision: 2,
    };
    for (const value of [
      { ...accepted, scope: { accountId: id(20), privacyEpoch: 2 } },
      { ...accepted, scope: { accountId, privacyEpoch: 3 } },
      { ...accepted, commandId: id(20) },
      { ...accepted, operation: 'friend.remove' as const },
      { ...accepted, peerPersonId: id(20) },
      { ...accepted, basePairRevision: 0 },
      { ...accepted, privatePairRevision: 20 },
    ]) {
      const f = fixture();
      f.command.mockResolvedValue({ kind: 'ok', value });
      await expect(call(f.controller.blockRoute(await admitted()), command('block'))).rejects.toMatchObject({
        code: 'INTERNAL',
      });
    }
  });
  it('binds the current profile/handle/person outputs without refreshing or silently replacing selections', async () => {
    const f = fixture(),
      request = await admitted();
    f.readProfile.mockResolvedValue({
      kind: 'ok',
      value: { ...envelope, scope: { accountId: id(20), privacyEpoch: 2 }, status: 'unclaimed', profileRevision: 0 },
    });
    await expect(call(f.controller.profileRoute(request), {})).rejects.toMatchObject({ code: 'INTERNAL' });
    f.setProfile.mockResolvedValue({
      kind: 'ok',
      value: {
        ...acceptance,
        commandId: id(20),
        operation: 'profile.set',
        baseProfileRevision: 0,
        acceptedProfileRevision: 1,
      },
    });
    await expect(call(f.controller.setProfileRoute(request), profile)).rejects.toMatchObject({ code: 'INTERNAL' });
    f.setProfile.mockResolvedValue({
      kind: 'ok',
      value: {
        ...acceptance,
        operation: 'profile.set',
        baseProfileRevision: 1,
        acceptedProfileRevision: 2,
      },
    });
    await expect(call(f.controller.setProfileRoute(request), profile)).rejects.toMatchObject({ code: 'INTERNAL' });
    f.lookup.mockResolvedValue({
      kind: 'ok',
      value: { ...envelope, status: 'available', person: { ...person, handle: 'replacement.b' }, pairRevision: 0 },
    });
    await expect(
      call(f.controller.lookupRoute(request), { version: 'sharing.v1', handle: person.handle }),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
    f.readPair.mockResolvedValue({
      kind: 'ok',
      value: {
        ...envelope,
        status: 'available',
        pair: { state: 'none', peer: { ...person, personId: id(20) }, pairRevision: 0 },
      },
    });
    await expect(call(f.controller.pairRoute(request), { version: 'sharing.v1', peerPersonId })).rejects.toMatchObject({
      code: 'INTERNAL',
    });
  });
  it.each([
    ['invalid_input', 'INVALID_REQUEST'],
    ['unavailable', 'SHARING_UNAVAILABLE'],
    ['unsupported', 'SHARING_UNAVAILABLE'],
    ['counter_exhausted', 'SHARING_UNAVAILABLE'],
    ['stale_revision', 'SHARING_REVISION_STALE'],
    ['command_key_reused', 'COMMAND_KEY_REUSED'],
  ] as const)('maps %s to one fixed public %s branch', async (refusal, code) => {
    const f = fixture();
    f.command.mockResolvedValue({ kind: 'refused', code: refusal });
    await expect(call(f.controller.blockRoute(await admitted()), command('block'))).rejects.toMatchObject({ code });
  });
  it('fails before any domain call if the global scope guard did not admit this request', async () => {
    const f = fixture();
    await expect(call(f.controller.profileRoute({} as Request), {})).rejects.toBeDefined();
    await expect(call(f.controller.blockRoute({} as Request), command('block'))).rejects.toBeDefined();
    for (const port of [f.readProfile, f.setProfile, f.lookup, f.readPair, f.command])
      expect(port).not.toHaveBeenCalled();
  });
});
