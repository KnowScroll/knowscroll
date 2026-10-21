import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  makeWithPersonalScope,
  transactionOf,
  type Database,
  type DatabaseHandle,
} from '@knowscroll/backend/infrastructure/postgres';
import { accountAccessUseCases } from '@knowscroll/backend/modules/identity/nest-providers';
import {
  privatePairId,
  socialStore,
  socialUseCases,
  type SocialPorts,
} from '@knowscroll/backend/modules/social/nest-providers';
import type { FriendOperation } from '@knowscroll/backend/modules/social';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { gate } from '../support/fixture-model.js';
const now0 = Date.parse('2026-10-21T00:00:00Z');
const v = 'sharing.v1';
type Cases = ReturnType<typeof socialUseCases>;
function cases(
  db: TestDatabase<Database>['db'],
  now = () => new Date(now0),
  store = socialStore,
  newId?: () => string,
) {
  const access = accountAccessUseCases({ db, lockTimeoutMs: 10_000 });
  return socialUseCases({
    withScope: makeWithPersonalScope(db, { lockTimeoutMs: 10_000 }),
    fencePair: access.fenceAccountPair,
    fenceOwn: access.fenceOwnAccount,
    now,
    store,
    ...(newId ? { newId } : {}),
  });
}
async function claimed(c: Cases, person: FixturePerson, handle: string) {
  expect(
    (
      await c.setProfile(person.authority, {
        version: v,
        commandId: randomUUID(),
        expectedProfileRevision: 0,
        handle,
        displayName: 'आशा',
      })
    ).kind,
  ).toBe('ok');
  const read = await c.readProfile(person.authority);
  if (read.kind !== 'ok' || read.value.status !== 'claimed') throw new Error('CI profile');
  return read.value.person;
}
async function pairView(c: Cases, actor: FixturePerson, personId: string) {
  const result = await c.readPair(actor.authority, { version: v, peerPersonId: personId });
  if (result.kind !== 'ok' || result.value.status !== 'available') throw new Error('CI pair');
  return result.value.pair;
}
function command(
  c: Cases,
  actor: FixturePerson,
  peer: string,
  op: FriendOperation,
  revision: number,
  requestId?: string,
  id = randomUUID(),
) {
  return c.command(actor.authority, op, {
    version: v,
    commandId: id,
    peerPersonId: peer,
    expectedPairRevision: revision,
    ...(requestId ? { requestId } : {}),
  });
}
async function request(
  c: Cases,
  actor: FixturePerson,
  peer: { personId: string; handle: string },
  revision = 0,
  id = randomUUID(),
) {
  const profile = await c.readProfile(actor.authority);
  if (profile.kind === 'ok' && profile.value.status === 'unclaimed')
    await claimed(c, actor, `ci.${actor.accountId.slice(0, 8)}`);
  return c.command(actor.authority, 'request', {
    version: v,
    commandId: id,
    expectedPeerPersonId: peer.personId,
    expectedPairRevision: revision,
    target: { kind: 'handle', handle: peer.handle },
  });
}
describe('Social foundation (CI real PostgreSQL, no HTTP or runtime contacts)', () => {
  let database: TestDatabase<Database>, other: DatabaseHandle<Database>;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('social_friends');
    other = createDatabase<Database>(database.settings, { onIdleClientError: () => undefined });
  });
  afterAll(async () => {
    await other.close();
    await database.drop();
  });
  it('claims independent public IDs, exact ASCII handles, international labels and strict private/C1 refusal', async () => {
    const c = cases(database.db),
      a = await seedPerson(database.db),
      b = await seedPerson(database.db);
    for (const displayName of ['A\u0080B', 'A\u0085B', 'A\u009fB', 'A\u0001B', 'A\u007fB', ' A'])
      expect(
        await c.setProfile(a.authority, {
          version: v,
          commandId: randomUUID(),
          expectedProfileRevision: 0,
          handle: 'asha.k',
          displayName,
        }),
      ).toEqual({ kind: 'refused', code: 'invalid_input' });
    const person = await claimed(c, a, 'asha.k');
    expect([a.accountId, a.universeId]).not.toContain(person.personId);
    expect(
      await c.setProfile(b.authority, {
        version: v,
        commandId: randomUUID(),
        expectedProfileRevision: 0,
        handle: 'asha.k',
        displayName: 'B',
      }),
    ).toEqual({ kind: 'refused', code: 'unavailable' });
    for (const handle of ['ABc', 'ab', 'a..b', 'a_', 'a@b.com'])
      expect(await c.lookup(a.authority, { version: v, handle })).toEqual({ kind: 'refused', code: 'invalid_input' });
    expect(await c.lookup(b.authority, { version: v, handle: 'asha.k', email: 'private@example.test' })).toEqual({
      kind: 'refused',
      code: 'invalid_input',
    });
    expect((await c.lookup(b.authority, { version: v, handle: 'asha.k' })).kind).toBe('ok');
  });
  it('serializes duplicate/reciprocal first creation, exact retries and explicit accept; revoke before old replay', async () => {
    const c = cases(database.db),
      a = await seedPerson(database.db),
      b = await seedPerson(database.db);
    const pa = await claimed(c, a, 'race.a'),
      pb = await claimed(c, b, 'race.b'),
      id = randomUUID();
    const results = await Promise.all([request(c, a, pb, 0, id), request(cases(other.db), a, pb, 0, id)]);
    expect(results.map((r) => r.kind)).toEqual(['ok', 'ok']);
    expect(results.filter((r) => r.kind === 'ok' && r.value.replayed)).toHaveLength(1);
    const view = await pairView(c, b, pa.personId);
    if (view.state !== 'incoming') throw new Error('CI incoming');
    const reciprocal = await request(c, b, pa, view.pairRevision);
    expect(reciprocal.kind).toBe('ok');
    expect((await pairView(c, a, pb.personId)).state).toBe('outgoing');
    expect(await request(c, a, pb, 1, id)).toEqual({ kind: 'refused', code: 'command_key_reused' });
    const acceptId = randomUUID();
    expect((await command(c, b, pa.personId, 'accept', view.pairRevision, view.requestId, acceptId)).kind).toBe('ok');
    expect((await command(c, b, pa.personId, 'accept', view.pairRevision, view.requestId, acceptId)).kind).toBe('ok');
    const friends = await pairView(c, a, pb.personId);
    expect(friends.state).toBe('friends');
    expect((await command(c, a, pb.personId, 'remove', friends.pairRevision)).kind).toBe('ok');
    expect(await command(c, b, pa.personId, 'accept', view.pairRevision, view.requestId, acceptId)).toEqual({
      kind: 'refused',
      code: 'unavailable',
    });
    const rows = await database.db
      .selectFrom('social.pairs')
      .selectAll()
      .where('pair_id', '=', privatePairId(a.accountId, b.accountId))
      .execute();
    expect(rows).toHaveLength(1);
  });
  it('serializes reciprocal first creators through one canonical pair, without autoaccept', async () => {
    const a = await seedPerson(database.db),
      b = await seedPerson(database.db),
      c = cases(database.db);
    const pa = await claimed(c, a, 'first.a'),
      pb = await claimed(c, b, 'first.b');
    const results = await Promise.all([request(c, a, pb), request(cases(other.db), b, pa)]);
    expect(results.filter((r) => r.kind === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'refused' && r.code === 'stale_revision')).toHaveLength(1);
    expect([(await pairView(c, a, pb.personId)).state, (await pairView(c, b, pa.personId)).state].sort()).toEqual([
      'incoming',
      'outgoing',
    ]);
    expect(
      await database.db
        .selectFrom('social.pairs')
        .selectAll()
        .where('pair_id', '=', privatePairId(a.accountId, b.accountId))
        .execute(),
    ).toHaveLength(1);
  });
  it('compares COMPLETE sender JSON in ignored and silently declined histories, including expiry and cancellation', async () => {
    const mirror = await createTestDatabase<Database>('social_history');
    try {
      const a = await seedPerson(database.db),
        b = await seedPerson(database.db);
      for (const person of [a, b]) {
        await mirror.db.insertInto('identity.accounts').values({ id: person.accountId }).execute();
        await mirror.db
          .insertInto('identity.universes')
          .values({ id: person.universeId, account_id: person.accountId })
          .execute();
      }
      const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()],
        commandId = randomUUID();
      let time = now0;
      const history = async (db: TestDatabase<Database>['db'], decline: boolean) => {
        let index = 0;
        const c = cases(
          db,
          () => new Date(time),
          socialStore,
          () => ids[index++]!,
        );
        const pa = await claimed(c, a, 'history.a'),
          pb = await claimed(c, b, 'history.b');
        const accepted = await request(c, a, pb, 0, commandId);
        const incoming = await pairView(c, b, pa.personId);
        if (incoming.state !== 'incoming') throw new Error('CI incoming');
        if (decline)
          expect((await command(c, b, pa.personId, 'decline', incoming.pairRevision, incoming.requestId)).kind).toBe(
            'ok',
          );
        const outgoing = await c.readPair(a.authority, { version: v, peerPersonId: pb.personId });
        const replay = await request(c, a, pb, 0, commandId);
        const retryId = 'f9707800-5f36-4f2e-8b16-51243c83e8a9';
        const noop = await request(c, a, pb, 1, retryId),
          stale = await request(c, a, pb, 0);
        time = now0 + 7 * 24 * 60 * 60 * 1000;
        const expired = await c.readPair(a.authority, { version: v, peerPersonId: pb.personId });
        time = now0;
        const cancel = await command(
          c,
          a,
          pb.personId,
          'cancel',
          1,
          incoming.requestId,
          '74693d69-94ae-4cab-82d1-89d9f1be9342',
        );
        return { accepted, outgoing, replay, noop, stale, expired, cancel };
      };
      const ignored = await history(database.db, false);
      expect(await history(mirror.db, true)).toEqual(ignored);
    } finally {
      await mirror.drop();
    }
  });
  it('block/unblock never restores; absent, inactive and blocked lookup use the same coarse shape', async () => {
    const c = cases(database.db),
      a = await seedPerson(database.db),
      b = await seedPerson(database.db),
      pb = await claimed(c, b, 'blocked.b');
    const absent = await c.lookup(a.authority, { version: v, handle: 'absent.person' });
    expect((await command(c, a, pb.personId, 'block', 0)).kind).toBe('ok');
    expect(await c.lookup(a.authority, { version: v, handle: pb.handle })).toEqual(absent);
    expect((await command(c, a, pb.personId, 'unblock', 1)).kind).toBe('ok');
    expect((await pairView(c, a, pb.personId)).state).toBe('none');
    await accountAccessUseCases({ db: database.db, lockTimeoutMs: 10000 }).invalidateOwnAccountAccess(
      b.authority,
      'suspend',
    );
    expect(await c.lookup(a.authority, { version: v, handle: pb.handle })).toEqual(absent);
    expect(await command(c, a, pb.personId, 'block', 2)).toEqual({ kind: 'refused', code: 'unavailable' });
  });
  it('rejects invites/private unknown fields without downgrade and binds current handle selection', async () => {
    const c = cases(database.db),
      a = await seedPerson(database.db),
      b = await seedPerson(database.db),
      pb = await claimed(c, b, 'binding.b');
    const base = { version: v, commandId: randomUUID(), expectedPeerPersonId: pb.personId, expectedPairRevision: 0 };
    expect(
      await c.command(a.authority, 'request', { ...base, target: { kind: 'invite', token: `ksfi_${'a'.repeat(43)}` } }),
    ).toEqual({ kind: 'refused', code: 'unsupported' });
    expect(
      await c.command(a.authority, 'request', {
        ...base,
        target: { kind: 'handle', handle: pb.handle, token: 'secret' },
      }),
    ).toEqual({ kind: 'refused', code: 'invalid_input' });
    expect(
      await c.command(a.authority, 'request', { ...base, target: { kind: 'handle', handle: 'someone.else' } }),
    ).toEqual({ kind: 'refused', code: 'unavailable' });
    expect(
      await database.db
        .selectFrom('social.command_bindings')
        .selectAll()
        .where('actor_account_id', '=', a.accountId)
        .execute(),
    ).toEqual([]);
  });
  it('rolls back pair effects AND receipt when a later atomic write fails', async () => {
    const a = await seedPerson(database.db),
      b = await seedPerson(database.db),
      c = cases(database.db),
      pb = await claimed(c, b, 'rollback.b');
    const broken: SocialPorts['store'] = {
      ...socialStore,
      receipt: () => Promise.reject(new Error('CI_ATOMIC_FAILURE')),
    };
    await expect(request(cases(database.db, undefined, broken), a, pb)).rejects.toThrow('CI_ATOMIC_FAILURE');
    expect(
      await database.db
        .selectFrom('social.pairs')
        .selectAll()
        .where('pair_id', '=', privatePairId(a.accountId, b.accountId))
        .execute(),
    ).toEqual([]);
    expect(
      await database.db
        .selectFrom('receipts.shared_commands')
        .selectAll()
        .where('actor_account_id', '=', a.accountId)
        .execute(),
    ).toEqual([]);
  });
  it('fences actor epoch before replay while retaining account friendship across reset', async () => {
    const c = cases(database.db),
      a = await seedPerson(database.db),
      b = await seedPerson(database.db),
      pb = await claimed(c, b, 'epoch.b'),
      id = randomUUID();
    expect((await request(c, a, pb, 0, id)).kind).toBe('ok');
    await accountAccessUseCases({ db: database.db, lockTimeoutMs: 10000 }).invalidateOwnAccountAccess(
      a.authority,
      'advance_epoch',
    );
    const fresh = { ...a, authority: { ...a.authority, privacyEpoch: 2 } };
    expect(await request(c, fresh, pb, 0, id)).toEqual({ kind: 'refused', code: 'unavailable' });
    expect((await pairView(c, fresh, pb.personId)).state).toBe('outgoing');
  });
  it('holds actual pair effects before suspension and refuses every later command/replay', async () => {
    const a = await seedPerson(database.db),
      b = await seedPerson(database.db),
      c = cases(database.db),
      pb = await claimed(c, b, 'suspend.b');
    const held = gate(),
      entered = gate();
    const heldStore: SocialPorts['store'] = {
      ...socialStore,
      savePair: async (lock, pair) => {
        await socialStore.savePair(lock, pair);
        entered.open();
        await held.promise;
      },
    };
    const pending = request(cases(database.db, undefined, heldStore), a, pb);
    await entered.promise;
    const suspension = accountAccessUseCases({ db: other.db, lockTimeoutMs: 10000 }).invalidateOwnAccountAccess(
      b.authority,
      'suspend',
    );
    try {
      await expect
        .poll(async () =>
          Number(
            (
              await sql<{
                n: number;
              }>`select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock'`.execute(
                database.db,
              )
            ).rows[0]?.n ?? 0,
          ),
        )
        .toBeGreaterThan(0);
    } finally {
      held.open();
    }
    expect((await pending).kind).toBe('ok');
    expect((await suspension).kind).toBe('entered');
    expect(await request(c, a, pb, 1)).toEqual({ kind: 'refused', code: 'unavailable' });
  });
  it('waiting pair reads fresh epoch-only reset, then suspension-before-gate refuses without effects', async () => {
    for (const suspend of [false, true]) {
      const a = await seedPerson(database.db),
        b = await seedPerson(database.db),
        c = cases(database.db),
        pb = await claimed(c, b, suspend ? 'wait.suspend' : 'wait.reset');
      const entered = gate(),
        held = gate();
      const access = accountAccessUseCases({ db: other.db, lockTimeoutMs: 10000 });
      const invalidation = makeWithPersonalScope(other.db, { lockTimeoutMs: 10000 })(b.authority, async (scope) => {
        expect((await access.fenceOwnAccount(scope)).kind).toBe('active');
        await sql`update identity.universes set privacy_epoch=privacy_epoch+1 where id=${b.universeId}::uuid`.execute(
          transactionOf(scope),
        );
        if (suspend)
          await sql`update identity.accounts set status='suspended' where id=${b.accountId}::uuid`.execute(
            transactionOf(scope),
          );
        entered.open();
        await held.promise;
      });
      await entered.promise;
      const pending = request(c, a, pb);
      try {
        await expect
          .poll(async () =>
            Number(
              (
                await sql<{
                  n: number;
                }>`select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock'`.execute(
                  database.db,
                )
              ).rows[0]?.n ?? 0,
            ),
          )
          .toBeGreaterThan(0);
      } finally {
        held.open();
      }
      await invalidation;
      expect(await pending).toMatchObject(suspend ? { kind: 'refused', code: 'unavailable' } : { kind: 'ok' });
      if (suspend)
        expect(
          await database.db
            .selectFrom('social.pairs')
            .selectAll()
            .where('pair_id', '=', privatePairId(a.accountId, b.accountId))
            .execute(),
        ).toEqual([]);
    }
  });
  it('fails closed for a deterministic pair UUID/account binding collision', async () => {
    const a = await seedPerson(database.db),
      b = await seedPerson(database.db),
      x = await seedPerson(database.db),
      y = await seedPerson(database.db),
      c = cases(database.db),
      pb = await claimed(c, b, 'collision.b');
    const [low, high] = [x.accountId, y.accountId].sort();
    await database.db
      .insertInto('social.pairs')
      .values({ pair_id: privatePairId(a.accountId, b.accountId), low_account_id: low!, high_account_id: high! })
      .execute();
    await expect(request(c, a, pb)).rejects.toThrow('SOCIAL_PAIR_BINDING');
    expect(
      await database.db
        .selectFrom('receipts.shared_commands')
        .selectAll()
        .where('actor_account_id', '=', a.accountId)
        .execute(),
    ).toEqual([]);
  });
  it('rejects SQL C1 labels and malformed subordinate account/lineage bindings', async () => {
    const a = await seedPerson(database.db),
      b = await seedPerson(database.db),
      x = await seedPerson(database.db),
      c = cases(database.db),
      pb = await claimed(c, b, 'sql.b');
    for (const displayName of ['A\u0080B', 'A\u0085B', 'A\u009fB'])
      await expect(
        database.db
          .insertInto('social.profiles')
          .values({
            account_id: x.accountId,
            person_id: randomUUID(),
            handle: 'sql.bad',
            display_name: displayName,
            profile_revision: 1,
          })
          .execute(),
      ).rejects.toMatchObject({ code: '23514' });
    expect((await request(c, a, pb)).kind).toBe('ok');
    const id = privatePairId(a.accountId, b.accountId);
    await expect(
      database.db.insertInto('social.pair_sides').values({ pair_id: id, account_id: x.accountId }).execute(),
    ).rejects.toThrow('social_pair_binding');
    await expect(
      database.db
        .insertInto('social.command_bindings')
        .values({
          pair_id: id,
          actor_account_id: x.accountId,
          operation: 'block',
          command_id: randomUUID(),
          actor_epoch: 1,
        })
        .execute(),
    ).rejects.toThrow('social_pair_binding');
    await expect(
      database.db
        .updateTable('social.pairs')
        .set({ accepted_lineage: randomUUID() })
        .where('pair_id', '=', id)
        .execute(),
    ).rejects.toMatchObject({ code: '23503' });
  });
  it('established block fences the old acceptance; unblock restores neither friendship nor replay authority', async () => {
    const a = await seedPerson(database.db),
      b = await seedPerson(database.db),
      c = cases(database.db),
      pa = await claimed(c, a, 'revoke.a'),
      pb = await claimed(c, b, 'revoke.b');
    await request(c, a, pb);
    const incoming = await pairView(c, b, pa.personId);
    if (incoming.state !== 'incoming') throw new Error('CI incoming');
    const id = randomUUID();
    expect((await command(c, b, pa.personId, 'accept', incoming.pairRevision, incoming.requestId, id)).kind).toBe('ok');
    expect((await command(c, a, pb.personId, 'block', 2)).kind).toBe('ok');
    expect(await command(c, b, pa.personId, 'accept', incoming.pairRevision, incoming.requestId, id)).toEqual({
      kind: 'refused',
      code: 'unavailable',
    });
    expect((await command(c, a, pb.personId, 'unblock', 3)).kind).toBe('ok');
    expect((await pairView(c, a, pb.personId)).state).toBe('none');
    expect(await command(c, b, pa.personId, 'accept', incoming.pairRevision, incoming.requestId, id)).toEqual({
      kind: 'refused',
      code: 'unavailable',
    });
  });
});
