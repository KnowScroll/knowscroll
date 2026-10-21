import { describe, expect, it } from 'vitest';
import {
  AcceptFriendSchema,
  BlockFriendSchema,
  CancelFriendRequestSchema,
  CreateFriendInviteResultSchema,
  CreateFriendInviteSchema,
  DeclineFriendSchema,
  FriendAvailabilitySchema,
  FriendCommandAcceptanceSchema,
  FriendInviteAcceptanceSchema,
  FriendPairViewSchema,
  LookupSharingPersonSchema,
  OwnFriendInvitesSchema,
  OwnSharingProfileSchema,
  PublicPersonRefSchema,
  ReadFriendRequestsSchema,
  ReadFriendsSchema,
  ReadVisitorWorldSchema,
  RequestFriendSchema,
  ResolveFriendInviteSchema,
  ResolvedFriendInviteSchema,
  RevokeFriendInviteSchema,
  SetPresencePreferenceSchema,
  SetSharingProfileSchema,
  SetSharingVisibilitySchema,
  SharingHandleSchema,
  SharingListPageSchema,
  SharingPersonLookupSchema,
  SharingProfileAcceptanceSchema,
  SharingVisibilityAcceptanceSchema,
  VisitorWorldSnapshotSchema,
  problemDetails,
  sharingContract,
} from './index.js';

// Synthetic wire fixtures only: no friendship, public projection or account authority is established.
const id = (n: number) => `0199f0a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const scope = { accountId: id(1), privacyEpoch: 3 };
const person = { kind: 'person', personId: id(2), handle: 'asha.k', displayName: 'Asha' };
const envelope = { version: 'sharing.v1', scope };
const command = { version: 'sharing.v1', commandId: id(3) };
const pairCommand = { ...command, peerPersonId: person.personId, expectedPairRevision: 7 };
const token = `ksfi_${'a'.repeat(43)}`;
const request = {
  ...command,
  expectedPeerPersonId: person.personId,
  expectedPairRevision: 0,
  target: { kind: 'handle', handle: person.handle },
};
const accepted = {
  ...envelope,
  commandId: id(3),
  recordedAt: '2026-10-21T10:00:00.000Z',
  replayed: false,
  outcome: 'accepted',
};
const pairAcceptance = {
  ...accepted,
  operation: 'friend.request',
  peerPersonId: person.personId,
  basePairRevision: 0,
  acceptedPairRevision: 1,
};
const inviteAcceptance = {
  ...accepted,
  operation: 'invite.create',
  linkId: id(4),
  baseInviteRevision: 0,
  acceptedInviteRevision: 1,
};
const incoming = { state: 'incoming', peer: person, pairRevision: 7, requestId: id(5) };
const cursor = { scope, filter: 'incoming', snapshotRevision: 6, token: 'cursor_fixture_only' };
const capabilities = { presentations: ['list.v1'] };
const target = { kind: 'person', personId: person.personId };
const visit = {
  ...envelope,
  target,
  capabilities,
  status: 'available',
  owner: person,
  authority: { pairRevision: 7, visibilityRevision: 4, publishedProjectionRevision: 2 },
  projection: { presentation: 'list.v1', systems: [{ publicSystemId: id(6), label: 'Fixture shared system' }] },
};

function refusesExtras(
  schema: { safeParse: (value: unknown) => { success: boolean } },
  fixture: object,
  fields: string[],
) {
  for (const field of fields)
    expect(schema.safeParse({ ...fixture, [field]: 'private-fixture' }).success, field).toBe(false);
}

describe('bounded Friends and visibility declarations', () => {
  it('accepts explicit ASCII handles without coercion, trimming or email-derived identity', () => {
    for (const handle of ['abc', 'asha.k', 'a_b.c', 'a'.repeat(24)])
      expect(SharingHandleSchema.parse(handle)).toBe(handle);
    for (const handle of [
      'ab',
      'a'.repeat(25),
      '.abc',
      'abc_',
      'a..b',
      'a._b',
      'Asha.k',
      '@asha.k',
      'a-b',
      'a b',
      'àbc',
      'a@b.co',
      ' abc',
      'abc\n',
    ])
      expect(SharingHandleSchema.safeParse(handle).success, handle).toBe(false);
    expect(PublicPersonRefSchema.parse(person)).toEqual(person);
    expect(PublicPersonRefSchema.parse({ ...person, displayName: 'आशा' }).displayName).toBe('आशा');
    for (const control of ['\u0080', '\u0085', '\u009f']) {
      expect(PublicPersonRefSchema.safeParse({ ...person, displayName: `A${control}B` }).success).toBe(false);
      expect(
        SetSharingProfileSchema.safeParse({
          ...command,
          expectedProfileRevision: 0,
          handle: person.handle,
          displayName: `A${control}B`,
        }).success,
      ).toBe(false);
    }
    refusesExtras(PublicPersonRefSchema, person, [
      'email',
      'accountId',
      'universeId',
      'topicCount',
      'lastSeenAt',
      'privateActivity',
    ]);
    expect(PublicPersonRefSchema.safeParse({ ...person, kind: 'ai' }).success).toBe(false);
    expect(
      SetSharingProfileSchema.parse({
        ...command,
        expectedProfileRevision: 0,
        handle: person.handle,
        displayName: 'Asha',
      }),
    ).toBeDefined();
    expect(
      OwnSharingProfileSchema.safeParse({ ...envelope, status: 'unclaimed', profileRevision: 1, person }).success,
    ).toBe(false);
    expect(
      SetSharingProfileSchema.safeParse({ ...command, expectedProfileRevision: 0, handle: 'abc', displayName: '\n' })
        .success,
    ).toBe(false);
    expect(
      SharingProfileAcceptanceSchema.safeParse({
        ...accepted,
        operation: 'profile.set',
        baseProfileRevision: 4,
        acceptedProfileRevision: 3,
      }).success,
    ).toBe(false);
  });

  it('keeps exact lookup and invite resolution read-only and uniformly unavailable', () => {
    expect(LookupSharingPersonSchema.parse({ version: 'sharing.v1', handle: person.handle })).toBeDefined();
    refusesExtras(LookupSharingPersonSchema, { version: 'sharing.v1', handle: person.handle }, [
      'email',
      'prefix',
      'commandId',
    ]);
    expect(SharingPersonLookupSchema.parse({ ...envelope, status: 'unavailable' })).toEqual({
      ...envelope,
      status: 'unavailable',
    });
    refusesExtras(SharingPersonLookupSchema, { ...envelope, status: 'unavailable' }, [
      'reason',
      'person',
      'pairRevision',
      'blocked',
    ]);
    expect(ResolveFriendInviteSchema.parse({ version: 'sharing.v1', token })).toBeDefined();
    expect(ResolvedFriendInviteSchema.safeParse({ ...envelope, status: 'unavailable', issuer: person }).success).toBe(
      false,
    );
    expect(ResolveFriendInviteSchema.safeParse({ version: 'sharing.v1', token: 'short' }).success).toBe(false);
  });

  it('requires exact command identity, target binding and pair revisions on distinct mutation branches', () => {
    expect(RequestFriendSchema.parse(request)).toEqual(request);
    expect(RequestFriendSchema.parse({ ...request, target: { kind: 'invite', token } })).toBeDefined();
    for (const targetValue of [
      { kind: 'handle', handle: person.handle, token },
      { kind: 'invite', token, handle: person.handle },
      { kind: 'invite' },
      { kind: 'unknown', handle: person.handle },
    ])
      expect(RequestFriendSchema.safeParse({ ...request, target: targetValue }).success).toBe(false);
    refusesExtras(RequestFriendSchema, request, ['actorId', 'grant', 'accept', 'automaticFormation']);
    expect(RequestFriendSchema.safeParse({ ...request, expectedPeerPersonId: undefined }).success).toBe(false);
    expect(RequestFriendSchema.safeParse({ ...request, commandId: undefined }).success).toBe(false);
    for (const schema of [AcceptFriendSchema, DeclineFriendSchema, CancelFriendRequestSchema]) {
      const input = { ...pairCommand, requestId: id(5) };
      expect(schema.parse(input)).toEqual(input);
      for (const expectedPairRevision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
        expect(schema.safeParse({ ...input, expectedPairRevision }).success).toBe(false);
      expect(schema.safeParse({ ...input, requestId: undefined }).success).toBe(false);
    }
    expect(BlockFriendSchema.parse({ ...pairCommand, expectedPairRevision: 0 })).toBeDefined();
    expect(
      sharingContract.unblock['~orpc'].inputSchema!.safeParse({ ...pairCommand, restoreFriendship: true }).success,
    ).toBe(false);
    expect(sharingContract.remove['~orpc'].inputSchema!.safeParse({ ...pairCommand, requestId: id(5) }).success).toBe(
      false,
    );
    expect(FriendCommandAcceptanceSchema.parse(pairAcceptance)).toEqual(pairAcceptance);
    expect(
      FriendCommandAcceptanceSchema.safeParse({ ...pairAcceptance, basePairRevision: 8, acceptedPairRevision: 7 })
        .success,
    ).toBe(false);
    expect(FriendCommandAcceptanceSchema.safeParse({ ...pairAcceptance, operation: 'friend.accept' }).success).toBe(
      false,
    );
    for (const [operation, procedure] of Object.entries({
      request: sharingContract.request,
      accept: sharingContract.accept,
      decline: sharingContract.decline,
      cancel: sharingContract.cancel,
      remove: sharingContract.remove,
      block: sharingContract.block,
      unblock: sharingContract.unblock,
    })) {
      const fixture = {
        ...pairAcceptance,
        operation: `friend.${operation}`,
        basePairRevision: 7,
        acceptedPairRevision: 8,
      };
      expect(procedure['~orpc'].outputSchema!.safeParse(fixture).success, operation).toBe(true);
      expect(procedure['~orpc'].outputSchema!.safeParse({ ...fixture, operation: 'friend.other' }).success).toBe(false);
    }
    refusesExtras(FriendCommandAcceptanceSchema, pairAcceptance, [
      'token',
      'target',
      'currentPair',
      'declinedAt',
      'peerBlocked',
    ]);
  });

  it('forbids sender-facing silent-decline state and binds pagination to filter, scope and snapshot', () => {
    expect(FriendPairViewSchema.parse(incoming)).toEqual(incoming);
    for (const state of ['declined', 'peer_blocked', 'expired'])
      expect(FriendPairViewSchema.safeParse({ ...incoming, state }).success).toBe(false);
    expect(
      FriendPairViewSchema.safeParse({ ...incoming, state: 'outgoing', declinedAt: '2026-10-21T10:01:00Z' }).success,
    ).toBe(false);
    const read = { version: 'sharing.v1', filter: 'incoming', limit: 10, cursor };
    expect(ReadFriendRequestsSchema.parse(read)).toEqual(read);
    expect(ReadFriendRequestsSchema.safeParse({ ...read, filter: 'outgoing' }).success).toBe(false);
    expect(ReadFriendsSchema.safeParse({ ...read, filter: 'friends' }).success).toBe(false);
    for (const limit of [0, 51, 1.1])
      expect(ReadFriendRequestsSchema.safeParse({ ...read, limit }).success).toBe(false);
    const page = { ...envelope, filter: 'incoming', snapshotRevision: 6, items: [incoming], next: cursor };
    expect(SharingListPageSchema.parse(page)).toEqual(page);
    for (const next of [
      { ...cursor, scope: { ...scope, privacyEpoch: 4 } },
      { ...cursor, scope: { ...scope, accountId: id(8) } },
      { ...cursor, filter: 'outgoing' },
      { ...cursor, snapshotRevision: 7 },
    ])
      expect(SharingListPageSchema.safeParse({ ...page, next }).success).toBe(false);
    expect(SharingListPageSchema.safeParse({ ...page, items: [] }).success).toBe(false);
    expect(SharingListPageSchema.safeParse({ ...page, items: [incoming, incoming] }).success).toBe(false);
    expect(SharingListPageSchema.safeParse({ ...page, filter: 'outgoing' }).success).toBe(false);
  });

  it('separates immutable invite acceptance and ephemeral first delivery with honest lost-response recovery', () => {
    expect(CreateFriendInviteSchema.parse({ ...command, expectedInviteRevision: 0 })).toBeDefined();
    const first = { acceptance: inviteAcceptance, delivery: { status: 'available', token } };
    expect(CreateFriendInviteResultSchema.parse(first)).toEqual(first);
    const replay = { acceptance: { ...inviteAcceptance, replayed: true }, delivery: { status: 'unavailable' } };
    expect(CreateFriendInviteResultSchema.parse(replay)).toEqual(replay);
    expect(CreateFriendInviteResultSchema.safeParse({ ...first, acceptance: replay.acceptance }).success).toBe(false);
    expect(
      CreateFriendInviteResultSchema.safeParse({
        ...first,
        acceptance: { ...inviteAcceptance, operation: 'invite.revoke' },
      }).success,
    ).toBe(false);
    refusesExtras(FriendInviteAcceptanceSchema, inviteAcceptance, ['token', 'url', 'secret', 'delivery']);
    expect(
      OwnFriendInvitesSchema.safeParse({
        ...envelope,
        invite: { status: 'active', linkId: id(4), inviteRevision: 1, token },
      }).success,
    ).toBe(false);
    expect(RevokeFriendInviteSchema.parse({ ...command, linkId: id(4), expectedInviteRevision: 1 })).toBeDefined();
    expect(RevokeFriendInviteSchema.safeParse({ ...command, linkId: id(4), expectedInviteRevision: 0 }).success).toBe(
      false,
    );
    expect(sharingContract.revokeInvite['~orpc'].outputSchema!.safeParse(inviteAcceptance).success).toBe(false);
  });

  it('requires explicit bounded visibility selections and independent preference authority', () => {
    const visibility = {
      ...command,
      expectedVisibilityRevision: 4,
      audience: { mode: 'chosen_friends', personIds: [person.personId] },
      sharedSystemIds: [id(6)],
    };
    expect(SetSharingVisibilitySchema.parse(visibility)).toEqual(visibility);
    for (const audience of [
      { mode: 'chosen_friends', personIds: [] },
      { mode: 'chosen_friends', personIds: [id(2), id(2)] },
      { mode: 'all_friends', personIds: [id(2)] },
      { mode: 'nobody', sharedSystemIds: [id(6)] },
    ])
      expect(SetSharingVisibilitySchema.safeParse({ ...visibility, audience }).success).toBe(false);
    expect(SetSharingVisibilitySchema.safeParse({ ...visibility, sharedSystemIds: [id(6), id(6)] }).success).toBe(
      false,
    );
    expect(SetSharingVisibilitySchema.safeParse({ ...visibility, expectedVisibilityRevision: undefined }).success).toBe(
      false,
    );
    expect(
      SharingVisibilityAcceptanceSchema.safeParse({
        ...accepted,
        operation: 'visibility.set',
        baseVisibilityRevision: 4,
        acceptedVisibilityRevision: 3,
      }).success,
    ).toBe(false);
    for (const preference of ['online', 'recently_active', 'hidden'])
      expect(
        SetPresencePreferenceSchema.parse({ ...command, expectedPresencePreferenceRevision: 2, preference }),
      ).toBeDefined();
    expect(
      SetPresencePreferenceSchema.safeParse({ ...command, expectedPairRevision: 2, preference: 'online' }).success,
    ).toBe(false);
  });

  it('collapses expired, hidden and unknown availability without exact timestamps or playback', () => {
    expect(FriendAvailabilitySchema.parse({ state: 'unknown' })).toEqual({ state: 'unknown' });
    expect(FriendAvailabilitySchema.safeParse({ state: 'unknown', expiryRevision: 2 }).success).toBe(false);
    expect(FriendAvailabilitySchema.parse({ state: 'online', expiryRevision: 2, validForMs: 20_000 })).toBeDefined();
    for (const validForMs of [0, -1, 86_400_001, Infinity])
      expect(FriendAvailabilitySchema.safeParse({ state: 'online', expiryRevision: 2, validForMs }).success).toBe(
        false,
      );
    for (const state of ['offline', 'hidden', 'expired'])
      expect(FriendAvailabilitySchema.safeParse({ state, expiryRevision: 2 }).success).toBe(false);
    refusesExtras(FriendAvailabilitySchema, { state: 'unknown' }, [
      'expiryRevision',
      'lastSeenAt',
      'expiresAt',
      'playhead',
      'topic',
      'validForMs',
    ]);
  });

  it('uses a separate public visitor allowlist with no private scene, location or evidence slots', () => {
    expect(VisitorWorldSnapshotSchema.parse(visit)).toEqual(visit);
    expect(
      VisitorWorldSnapshotSchema.safeParse({
        ...visit,
        projection: { ...visit.projection, systems: [{ publicSystemId: id(6), label: 'विज्ञान' }] },
      }).success,
    ).toBe(true);
    for (const control of ['\u0080', '\u0085', '\u009f'])
      expect(
        VisitorWorldSnapshotSchema.safeParse({
          ...visit,
          projection: { ...visit.projection, systems: [{ publicSystemId: id(6), label: `A${control}B` }] },
        }).success,
      ).toBe(false);
    const read = { version: 'sharing.v1', target, capabilities, expected: visit.authority };
    expect(ReadVisitorWorldSchema.parse(read)).toEqual(read);
    expect(
      VisitorWorldSnapshotSchema.parse({ ...envelope, target, capabilities, status: 'unavailable' }),
    ).toBeDefined();
    refusesExtras(VisitorWorldSnapshotSchema, { ...envelope, target, capabilities, status: 'unavailable' }, [
      'owner',
      'authority',
      'projection',
      'reason',
    ]);
    for (const capabilities of [
      { presentations: [] },
      { presentations: ['scene.v1'] },
      { presentations: ['list.v1', 'list.v1'] },
      { presentations: ['list.v1'], privateScene: true },
    ])
      expect(ReadVisitorWorldSchema.safeParse({ ...read, capabilities }).success).toBe(false);
    expect(
      ReadVisitorWorldSchema.safeParse({ ...read, expected: { ...visit.authority, visibilityRevision: 0 } }).success,
    ).toBe(false);
    expect(
      VisitorWorldSnapshotSchema.safeParse({ ...visit, target: { kind: 'person', personId: id(8) } }).success,
    ).toBe(false);
    expect(
      VisitorWorldSnapshotSchema.safeParse({ ...visit, target: { kind: 'handle', handle: 'other.person' } }).success,
    ).toBe(false);
    expect(
      VisitorWorldSnapshotSchema.safeParse({
        ...visit,
        projection: { ...visit.projection, systems: [visit.projection.systems[0], visit.projection.systems[0]] },
      }).success,
    ).toBe(false);
    for (const field of [
      'universeId',
      'scene',
      'descriptor',
      'seed',
      'anchor',
      'coordinates',
      'hiddenCount',
      'layoutGaps',
      'geographyRevision',
      'personalWatermark',
      'privateIds',
      'evidence',
      'playhead',
      'seen',
      'branch',
      'lastSeenAt',
    ]) {
      refusesExtras(VisitorWorldSnapshotSchema, visit, [field]);
      expect(
        VisitorWorldSnapshotSchema.safeParse({
          ...visit,
          projection: { ...visit.projection, [field]: 'private-fixture' },
        }).success,
        field,
      ).toBe(false);
      expect(
        VisitorWorldSnapshotSchema.safeParse({
          ...visit,
          projection: {
            ...visit.projection,
            systems: [{ ...visit.projection.systems[0], [field]: 'private-fixture' }],
          },
        }).success,
        field,
      ).toBe(false);
    }
  });

  it('uses fixed sanitised sharing problems with no peer denial distinctions', () => {
    expect(problemDetails('SHARING_UNAVAILABLE')).toEqual({
      type: 'tag:knowscroll.space,2026:problem:sharing-unavailable',
      title: 'This sharing resource is not available.',
      status: 404,
      code: 'SHARING_UNAVAILABLE',
    });
    expect(problemDetails('SHARING_REVISION_STALE').status).toBe(409);
  });
});
