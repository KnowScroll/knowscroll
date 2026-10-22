/** Hosted Actions only: authored public side index, real disposable PostgreSQL, no contacts. */
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { socialUseCases, privatePairId, type SocialPorts } from '@knowscroll/backend/modules/social/nest-providers';
import { accountAccessUseCases } from '@knowscroll/backend/modules/identity/nest-providers';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
const version = 'sharing.v1' as const,
  pages = 'friend-pages.v2' as const;
const publicId = (n: number) => `60000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
describe('bounded current Friends roster protocol (authored PG data)', () => {
  let db: TestDatabase<Database>,
    now = Date.parse('2026-10-23T00:00:00Z');
  beforeAll(async () => {
    db = await createTestDatabase<Database>('social_rosters');
  });
  afterAll(async () => {
    await db.drop();
  });
  function cases(cursor?: SocialPorts['cursor']) {
    const a = accountAccessUseCases({ db: db.db, lockTimeoutMs: 5000 });
    return socialUseCases({
      withScope: makeWithPersonalScope(db.db, { lockTimeoutMs: 5000 }),
      fenceOwn: a.fenceOwnAccount,
      fencePair: a.fenceAccountPair,
      now: () => new Date(now),
      ...(cursor ? { cursor } : {}),
    });
  }
  async function claimed() {
    const p = await seedPerson(db.db),
      c = cases();
    await c.setProfile(p.authority, {
      version,
      commandId: randomUUID(),
      expectedProfileRevision: 0,
      handle: `ci.${p.accountId.replaceAll('-', '').slice(0, 16)}`,
      displayName: '友人',
    });
    const r = await c.readProfile(p.authority);
    if (r.kind !== 'ok' || r.value.status !== 'claimed') throw new Error('CI_PROFILE');
    return { ...p, person: r.value.person };
  }
  const page = (filter: 'friends' | 'blocked' | 'incoming' | 'outgoing', limit = 20) => ({
    version: pages,
    requestId: randomUUID(),
    filter,
    limit,
  });
  async function request(a: FixturePerson, b: Awaited<ReturnType<typeof claimed>>) {
    expect(
      (
        await cases().command(a.authority, 'request', {
          version,
          commandId: randomUUID(),
          expectedPeerPersonId: b.person.personId,
          expectedPairRevision: 0,
          target: { kind: 'handle', handle: b.person.handle },
        })
      ).kind,
    ).toBe('ok');
  }
  it('does not truncate a long unavailable run: empty authenticated continuation advances to later real rows', async () => {
    const owner = await claimed(),
      c = cases();
    // Bulk fixture builds actual current public sides; the SQL projection/binding triggers run.
    const peers = Array.from({ length: 252 }, (_, i) => ({
      accountId: randomUUID(),
      universeId: randomUUID(),
      personId: publicId(i + 1),
    }));
    await db.db
      .insertInto('identity.accounts')
      .values(peers.map((p, i) => ({ id: p.accountId, status: i < 250 ? 'suspended' : 'active' })))
      .execute();
    await db.db
      .insertInto('identity.universes')
      .values(peers.map((p) => ({ id: p.universeId, account_id: p.accountId })))
      .execute();
    await db.db
      .insertInto('social.profiles')
      .values(
        peers.map((p, i) => ({
          account_id: p.accountId,
          person_id: p.personId,
          handle: `ci.scan.${i}`,
          display_name: 'Synthetic',
          profile_revision: 1,
        })),
      )
      .execute();
    await db.db
      .insertInto('social.pairs')
      .values(
        peers.map((p) => {
          const [low, high] = [p.accountId, owner.accountId].sort();
          return { pair_id: privatePairId(p.accountId, owner.accountId), low_account_id: low!, high_account_id: high! };
        }),
      )
      .execute();
    await db.db
      .insertInto('social.pair_sides')
      .values(
        peers.flatMap((p) => [
          {
            pair_id: privatePairId(p.accountId, owner.accountId),
            account_id: p.accountId,
            own_blocked: false,
            public_revision: 0,
            public_state: 'none',
          },
          {
            pair_id: privatePairId(p.accountId, owner.accountId),
            account_id: owner.accountId,
            own_blocked: true,
            public_revision: 1,
            public_state: 'blocked',
          },
        ]),
      )
      .execute();
    const q = page('blocked'),
      first = await c.readFriends(owner.authority, q);
    if (first.kind !== 'ok') throw new Error('CI_PAGE');
    expect(first.value).toMatchObject({ version: pages, requestId: q.requestId, filter: 'blocked', items: [] });
    expect(first.value.next).toBeDefined();
    const next = await c.readFriends(owner.authority, { ...q, requestId: randomUUID(), cursor: first.value.next });
    if (next.kind !== 'ok') throw new Error('CI_PAGE');
    expect(next.value.items.map((p) => p.peer.personId)).toEqual(peers.slice(250).map((p) => p.personId));
    expect(next.value.next).toBeUndefined();
    expect(await c.readFriends(owner.authority, { ...q, limit: 19, cursor: first.value.next })).toEqual({
      kind: 'refused',
      code: 'unavailable',
    });
    expect(await cases().readFriends(owner.authority, { ...q, cursor: first.value.next })).toEqual({
      kind: 'refused',
      code: 'unavailable',
    });
    const foreign = await claimed();
    expect(await c.readFriends(foreign.authority, { ...q, cursor: first.value.next })).toEqual({
      kind: 'refused',
      code: 'unavailable',
    });
  });
  it('silent decline/block preserves sender head/items and exact existing traversal authority', async () => {
    const a = await claimed(),
      b = await claimed(),
      d = await claimed(),
      c = cases();
    await request(a, b);
    await request(a, d);
    const q = page('outgoing', 1),
      first = await c.readRequests(a.authority, q);
    if (first.kind !== 'ok' || !first.value.next) throw new Error('CI_PAGE');
    const incoming = await c.readPair(b.authority, { version, peerPersonId: a.person.personId });
    if (incoming.kind !== 'ok' || incoming.value.status !== 'available' || incoming.value.pair.state !== 'incoming')
      throw new Error('CI_INCOMING');
    const before = await db.db
      .selectFrom('social.roster_heads')
      .selectAll()
      .where('owner_account_id', '=', a.accountId)
      .execute();
    await c.command(b.authority, 'decline', {
      version,
      commandId: randomUUID(),
      peerPersonId: a.person.personId,
      expectedPairRevision: incoming.value.pair.pairRevision,
      requestId: incoming.value.pair.requestId,
    });
    await c.command(b.authority, 'block', {
      version,
      commandId: randomUUID(),
      peerPersonId: a.person.personId,
      expectedPairRevision: 2,
    });
    expect(
      await db.db.selectFrom('social.roster_heads').selectAll().where('owner_account_id', '=', a.accountId).execute(),
    ).toEqual(before);
    const after = await c.readRequests(a.authority, q);
    if (after.kind !== 'ok') throw new Error('CI_PAGE');
    expect(after.value.items).toEqual(first.value.items);
    expect(after.value.snapshotRevision).toBe(first.value.snapshotRevision);
    const continued = await c.readRequests(a.authority, { ...q, requestId: randomUUID(), cursor: first.value.next });
    expect(continued.kind).toBe('ok');
    now += 604800000;
    expect(await c.readRequests(a.authority, { ...q, cursor: first.value.next })).toEqual({
      kind: 'refused',
      code: 'unavailable',
    });
    const expired = await c.readRequests(a.authority, page('outgoing'));
    expect(expired).toMatchObject({ kind: 'ok', value: { items: [] } });
  });
  it('current own root/epoch/account authority precedes cursor decoding; no read creates rows', async () => {
    const a = await claimed();
    let decodes = 0;
    const c = cases({
      encode: () => '',
      decode: () => {
        decodes++;
        return undefined;
      },
    });
    const q = {
      ...page('friends'),
      cursor: {
        scope: { accountId: a.accountId, privacyEpoch: 1 },
        filter: 'friends',
        snapshotRevision: 1,
        token: 'invalid',
      },
    };
    await accountAccessUseCases({ db: db.db, lockTimeoutMs: 5000 }).invalidateOwnAccountAccess(a.authority, 'suspend');
    expect(await c.readFriends(a.authority, q)).toEqual({ kind: 'refused', code: 'unavailable' });
    expect(decodes).toBe(0);
    expect(
      await db.db.selectFrom('social.roster_heads').selectAll().where('owner_account_id', '=', a.accountId).execute(),
    ).toEqual([]);
  });
  it('actual pair write and public index/head roll back together when receipt completion fails', async () => {
    const a = await claimed(),
      b = await claimed(),
      access = accountAccessUseCases({ db: db.db, lockTimeoutMs: 5000 });
    const { socialStore } = await import('@knowscroll/backend/modules/social/nest-providers');
    const c = socialUseCases({
      withScope: makeWithPersonalScope(db.db, { lockTimeoutMs: 5000 }),
      fenceOwn: access.fenceOwnAccount,
      fencePair: access.fenceAccountPair,
      store: { ...socialStore, receipt: () => Promise.reject(new Error('CI_ATOMIC_ROSTER_FAILURE')) },
    });
    await expect(
      c.command(a.authority, 'request', {
        version,
        commandId: randomUUID(),
        expectedPeerPersonId: b.person.personId,
        expectedPairRevision: 0,
        target: { kind: 'handle', handle: b.person.handle },
      }),
    ).rejects.toThrow('CI_ATOMIC_ROSTER_FAILURE');
    expect(
      await db.db.selectFrom('social.roster_entries').selectAll().where('owner_account_id', '=', a.accountId).execute(),
    ).toEqual([]);
    expect(
      await db.db.selectFrom('social.roster_heads').selectAll().where('owner_account_id', '=', a.accountId).execute(),
    ).toEqual([]);
    expect(
      await db.db
        .selectFrom('social.pairs')
        .selectAll()
        .where('pair_id', '=', privatePairId(a.accountId, b.accountId))
        .execute(),
    ).toEqual([]);
  });
});
