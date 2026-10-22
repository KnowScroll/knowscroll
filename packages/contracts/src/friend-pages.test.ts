import { describe, expect, it } from 'vitest';
import {
  apiContract,
  friendPagesContract,
  FriendPairViewSchema,
  FriendPagesPageSchema,
  FriendsPageSchema,
  FriendRequestsPageSchema,
  ReadFriendsPageSchema,
  ReadFriendRequestsPageSchema,
  ReadFriendsSchema,
  ReadFriendRequestsSchema,
  SharingListCursorSchema,
  SharingListPageSchema,
  sharingContract,
  SocialProblemSchema,
  SocialProblemIssueSchema,
  problemDetails,
  type ProblemCode,
} from './index.js';

const id = (n: number) => `0199f0a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const version = 'friend-pages.v2' as const;
const scope = { accountId: id(1), privacyEpoch: 2 };
const person = (n: number) => ({ kind: 'person', personId: id(n), handle: `friend${n}`, displayName: `Friend ${n}` });
const pair = (filter: 'friends' | 'blocked' | 'incoming' | 'outgoing', n = 20) => ({
  state: filter,
  peer: person(n),
  pairRevision: 7,
  ...(filter === 'friends' ? { availability: { state: 'unknown' } } : {}),
  ...(filter === 'incoming' || filter === 'outgoing' ? { requestId: id(n + 100) } : {}),
});
const cursor = { scope, filter: 'friends', snapshotRevision: 8, token: 'opaque_scan_2' };
const request = { version, requestId: id(2), filter: 'friends', limit: 20 };
const page = { version, requestId: id(2), scope, filter: 'friends', snapshotRevision: 8, items: [pair('friends')] };

describe('friend-pages.v2 declarations (synthetic contract fixtures only)', () => {
  it('declares two separate strict pure reads without changing legacy v1 routes or bindings', () => {
    expect(Object.keys(friendPagesContract)).toEqual(['friends', 'requests']);
    expect(apiContract.friendPages).toBe(friendPagesContract);
    expect(apiContract.sharing).toBe(sharingContract);
    expect(friendPagesContract.friends['~orpc'].route).toMatchObject({
      method: 'POST',
      path: '/v1/social/friends/page',
      successStatus: 200,
    });
    expect(friendPagesContract.requests['~orpc'].route).toMatchObject({
      method: 'POST',
      path: '/v1/social/requests/page',
      successStatus: 200,
    });
    expect(sharingContract.friends['~orpc'].route).toMatchObject({ method: 'POST', path: '/v1/social/friends/read' });
    expect(sharingContract.requests['~orpc'].route).toMatchObject({ method: 'POST', path: '/v1/social/requests/read' });
    expect(ReadFriendsPageSchema.parse(request)).toEqual(request);
    expect(ReadFriendsSchema.parse({ version: 'sharing.v1', filter: 'friends', limit: 20 })).toEqual({
      version: 'sharing.v1',
      filter: 'friends',
      limit: 20,
    });
  });

  it('requires independent UUID request correlation, exact version/filter and bounded noncoerced limits', () => {
    for (const key of Object.keys(request)) {
      const missing: Record<string, unknown> = { ...request };
      delete missing[key];
      expect(ReadFriendsPageSchema.safeParse(missing).success).toBe(false);
    }
    for (const limit of [1, 50]) expect(ReadFriendsPageSchema.parse({ ...request, limit }).limit).toBe(limit);
    for (const limit of [0, -1, 51, 1.5, '20', NaN, Infinity, null])
      expect(ReadFriendsPageSchema.safeParse({ ...request, limit }).success).toBe(false);
    for (const extra of [
      { requestId: 'invalid' },
      { requestId: undefined },
      { version: 'sharing.v1' },
      { version: 'friend-pages.v3' },
      { filter: 'incoming' },
      { filter: 'outgoing' },
      { filter: 'none' },
      { filter: 'Friends' },
      { accountId: id(1) },
      { universeId: id(1) },
      { commandId: id(3) },
      { force: true },
      { after: id(4) },
    ])
      expect(ReadFriendsPageSchema.safeParse({ ...request, ...extra }).success).toBe(false);
    for (const filter of ['incoming', 'outgoing']) {
      const read = { ...request, filter };
      expect(ReadFriendRequestsPageSchema.parse(read)).toEqual(read);
      expect(ReadFriendRequestsPageSchema.safeParse({ ...read, filter: 'friends' }).success).toBe(false);
      expect(ReadFriendRequestsPageSchema.safeParse({ ...read, filter: 'blocked' }).success).toBe(false);
    }
    expect(ReadFriendsPageSchema.parse({ ...request, filter: 'blocked' })).toBeDefined();
    expect(ReadFriendsPageSchema.safeParse({ version: 'sharing.v1', filter: 'friends', limit: 20 }).success).toBe(
      false,
    );
    expect(ReadFriendsSchema.safeParse(request).success).toBe(false);
    expect(ReadFriendRequestsSchema.safeParse({ ...request, filter: 'incoming' }).success).toBe(false);
  });

  it('reuses exact canonical cursor syntax and binds the cursor filter to either read', () => {
    expect(SharingListCursorSchema.parse(cursor)).toEqual(cursor);
    expect(ReadFriendsPageSchema.parse({ ...request, cursor })).toEqual({ ...request, cursor });
    for (const filter of ['incoming', 'outgoing', 'blocked'])
      expect(ReadFriendsPageSchema.safeParse({ ...request, cursor: { ...cursor, filter } }).success).toBe(false);
    for (const filter of ['incoming', 'outgoing']) {
      const read = { ...request, filter, cursor: { ...cursor, filter } };
      expect(ReadFriendRequestsPageSchema.parse(read)).toEqual(read);
      expect(ReadFriendRequestsPageSchema.safeParse({ ...read, cursor }).success).toBe(false);
    }
    for (const extra of [
      { token: '' },
      { token: 'a'.repeat(257) },
      { token: 'sensitive/path' },
      { token: 'invalid token' },
      { snapshotRevision: 0 },
      { snapshotRevision: 1.5 },
      { scope: { ...scope, privacyEpoch: 0 } },
      { scope: { ...scope, accountId: 'private' } },
      { scope: { ...scope, universeId: id(3) } },
      { anchor: id(20) },
      { ceiling: id(90) },
      { expiresAt: '2026-10-22T00:00:00.000Z' },
    ])
      expect(ReadFriendsPageSchema.safeParse({ ...request, cursor: { ...cursor, ...extra } }).success).toBe(false);
  });

  it('allows an empty advancing scan page and an empty exhausted page while preserving the v1 prohibition', () => {
    const scanning = { ...page, items: [], next: cursor };
    const exhausted = { ...page, items: [] };
    expect(FriendsPageSchema.parse(scanning)).toEqual(scanning);
    expect(FriendsPageSchema.parse(exhausted)).toEqual(exhausted);
    const { requestId: _requestId, version: _version, ...legacy } = scanning;
    expect(SharingListPageSchema.safeParse({ ...legacy, version: 'sharing.v1' }).success).toBe(false);
    const { next: _next, ...legacyEnd } = legacy;
    expect(SharingListPageSchema.parse({ ...legacyEnd, version: 'sharing.v1' })).toEqual({
      ...legacyEnd,
      version: 'sharing.v1',
    });
    for (const filter of ['incoming', 'outgoing'] as const) {
      const response = { ...scanning, filter, next: { ...cursor, filter } };
      expect(FriendRequestsPageSchema.parse(response)).toEqual(response);
      const { next: _next, ...end } = response;
      expect(FriendRequestsPageSchema.parse(end)).toEqual(end);
    }
  });

  it('closes item count and uniqueness over the actual matching canonical pair views', () => {
    for (const filter of ['friends', 'blocked', 'incoming', 'outgoing'] as const) {
      const items = Array.from({ length: 50 }, (_, n) => pair(filter, n + 20));
      for (const item of items) expect(FriendPairViewSchema.parse(item)).toEqual(item);
      const response = { ...page, filter, items };
      expect(FriendPagesPageSchema.parse(response)).toEqual(response);
      const selected = filter === 'friends' || filter === 'blocked' ? FriendsPageSchema : FriendRequestsPageSchema;
      expect(selected.parse(response)).toEqual(response);
      expect(selected.safeParse({ ...response, items: [...items, pair(filter, 90)] }).success).toBe(false);
      expect(selected.safeParse({ ...response, items: [items[0], items[0]] }).success).toBe(false);
      expect(
        selected.safeParse({
          ...response,
          items: [items[0], { ...items[0], peer: { ...person(20), handle: 'other' } }],
        }).success,
      ).toBe(false);
      expect(
        selected.safeParse({ ...response, items: [pair(filter === 'friends' ? 'blocked' : 'friends')] }).success,
      ).toBe(false);
    }
    expect(FriendsPageSchema.safeParse({ ...page, filter: 'incoming', items: [pair('incoming')] }).success).toBe(false);
    expect(FriendRequestsPageSchema.safeParse(page).success).toBe(false);
    expect(
      FriendPagesPageSchema.safeParse({ ...page, items: [{ state: 'none', peer: person(20), pairRevision: 0 }] })
        .success,
    ).toBe(false);
  });

  it('binds every continuation to current response scope, filter and public snapshot', () => {
    expect(FriendsPageSchema.parse({ ...page, next: cursor })).toEqual({ ...page, next: cursor });
    for (const extra of [
      { filter: 'blocked' },
      { snapshotRevision: 7 },
      { scope: { ...scope, accountId: id(3) } },
      { scope: { ...scope, privacyEpoch: 3 } },
    ])
      expect(FriendsPageSchema.safeParse({ ...page, next: { ...cursor, ...extra } }).success).toBe(false);
    for (const extra of [
      { version: 'sharing.v1' },
      { requestId: 'invalid' },
      { requestId: undefined },
      { snapshotRevision: 0 },
      { scope: { ...scope, universeId: id(3) } },
      { scope: { ...scope, privacyEpoch: 0 } },
      { next: null },
      { items: null },
      { filter: 'none' },
    ])
      expect(FriendsPageSchema.safeParse({ ...page, ...extra }).success).toBe(false);
  });

  it('refuses private counters, peer causes, raw anchors, progress and new presence fields', () => {
    for (const items of [[], page.items])
      for (const extra of [
        { peerEpoch: 2 },
        { internalPairRevision: 9 },
        { pairId: id(20) },
        { universeId: id(1) },
        { total: 1 },
        { scanned: 100 },
        { progress: 50 },
        { done: true },
        { expiresAt: '2026-10-22T00:00:00.000Z' },
        { anchor: id(20) },
        { lastSeenAt: '2026-10-22T00:00:00.000Z' },
        { unavailableReason: 'peer_blocked' },
      ])
        expect(FriendsPageSchema.safeParse({ ...page, items, ...extra }).success).toBe(false);
    for (const extra of [{ peerEpoch: 2 }, { pairId: id(20) }, { declined: true }, { seen: true }, { positionMs: 10 }])
      expect(FriendsPageSchema.safeParse({ ...page, items: [{ ...pair('friends'), ...extra }] }).success).toBe(false);
    expect(
      FriendsPageSchema.safeParse({
        ...page,
        items: [{ ...pair('friends'), availability: { state: 'unknown', lastSeenAt: 'private' } }],
      }).success,
    ).toBe(false);
  });

  it('reuses the closed Social RFC9457 family without admitting received paths or private values', () => {
    const errors = friendPagesContract.friends['~orpc'].errorMap;
    expect(friendPagesContract.requests['~orpc'].errorMap).toEqual(errors);
    expect(Object.keys(errors)).toEqual([
      'INVALID_REQUEST',
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'ORIGIN_NOT_ALLOWED',
      'UNIVERSE_UNAVAILABLE',
      'SHARING_UNAVAILABLE',
      'SHARING_REVISION_STALE',
      'CONFLICT',
      'PRIVACY_EPOCH_CHANGED',
      'SCOPE_MISMATCH',
      'COMMAND_KEY_REUSED',
      'PAYLOAD_TOO_LARGE',
      'UNSUPPORTED_MEDIA_TYPE',
      'UNPROCESSABLE_REQUEST',
      'TOO_MANY_REQUESTS',
      'SERVICE_UNAVAILABLE',
      'INTERNAL',
    ]);
    for (const [code, error] of Object.entries(errors)) {
      const problem = problemDetails(code as ProblemCode);
      expect(SocialProblemSchema.parse(problem)).toEqual(problem);
      expect(error.data.parse(problem)).toEqual(problem);
      for (const extra of [
        { detail: 'private' },
        { instance: '/private' },
        { cursor },
        { peerEpoch: 3 },
        { status: 200 },
      ])
        expect(error.data.safeParse({ ...problem, ...extra }).success).toBe(false);
    }
    expect(SocialProblemIssueSchema.parse({ path: ['unknown'], code: 'custom' })).toEqual({
      path: ['unknown'],
      code: 'custom',
    });
    for (const path of [['requestId'], ['filter'], ['private-key'], [0], ['0']])
      expect(SocialProblemIssueSchema.safeParse({ path, code: 'custom' }).success).toBe(false);
  });
});
