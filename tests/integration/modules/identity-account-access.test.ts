import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  enterSharedRoot,
  LockOrderError,
  makeWithPersonalScope,
  makeWithResolvedPersonalScope,
  ScopeClosedError,
  transactionOf,
  type Database,
  type DatabaseHandle,
} from '@knowscroll/backend/infrastructure/postgres';
import {
  completeSharedReceipt,
  findSharedReceipt,
  insertSharedReceipt,
  requestHash,
} from '@knowscroll/backend/infrastructure/receipts';
import { accountAccessProviders, accountAccessUseCases } from '@knowscroll/backend/modules/identity/nest-providers';
import {
  FENCE_ACCOUNT_PAIR,
  FENCE_OWN_ACCOUNT,
  INVALIDATE_OWN_ACCOUNT_ACCESS,
  READ_RECORDING_LIFECYCLE,
  type PersonalAuthority,
  type PersonalScopeTx,
} from '@knowscroll/backend/modules/identity';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { gate } from '../support/fixture-model.js';
import { seedAsset, seedPerson } from '../support/fixtures.js';

/** CI fixtures only: one content row stands in for a future Social pair root. No Social product is implemented. */
describe('Identity account access fences (real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  let other: DatabaseHandle<Database>;
  const scope = (db = database.db, lockTimeoutMs = 10_000) => makeWithPersonalScope(db, { lockTimeoutMs });
  const cases = (db = database.db, lockTimeoutMs = 10_000) => accountAccessUseCases({ db, lockTimeoutMs });
  beforeAll(async () => {
    database = await createTestDatabase<Database>('identity_account_access');
    other = createDatabase<Database>(database.settings, { onIdleClientError: () => undefined });
  });
  afterAll(async () => {
    await other.close();
    await database.drop();
  });

  async function waiting() {
    const result = await sql<{ n: number }>`select count(*)::int as n from pg_stat_activity
      where datname=current_database() and wait_event_type='Lock'`.execute(database.db);
    return result.rows[0]?.n ?? 0;
  }
  async function fixtureRoot(sc: PersonalScopeTx, id: string) {
    const shared = await enterSharedRoot(sc, {
      kind: 'ci_pair',
      id,
      lock: async (trx) =>
        (await trx.selectFrom('content.assets').select('id').where('id', '=', id).forUpdate().executeTakeFirst()) !==
        undefined,
    });
    if (shared === undefined) throw new Error('missing CI pair root');
    return shared;
  }
  const key = (epoch: number) => ({
    operation: 'fixture.pair',
    commandId: randomUUID(),
    requestHash: requestHash('fixture.pair', { epoch }),
    outcomeVersion: 1,
  });

  it('orders a pair commit before peer invalidation without acquiring the peer root', async () => {
    const a = await seedPerson(database.db),
      b = await seedPerson(database.db),
      root = await seedAsset(database.db);
    const held = gate(),
      entered = gate();
    const receipt = key(1);
    const pair = scope()(a.authority, async (sc) => {
      expect((await cases().fenceAccountPair(sc, b.accountId)).kind).toBe('active');
      const shared = await fixtureRoot(sc, root.assetId);
      await insertSharedReceipt(shared, receipt);
      await completeSharedReceipt(shared, receipt, { accepted: true });
      entered.open();
      await held.promise;
    });
    await entered.promise;
    const invalidation = cases(other.db).invalidateOwnAccountAccess(b.authority, 'advance_epoch');
    try {
      await expect.poll(waiting).toBeGreaterThan(0);
      // Lifecycle has entered B's root and is waiting at its account UPDATE; the pair can finish.
      const blockedRoot = scope(database.db, 150)(b.authority, () => Promise.resolve(undefined));
      await expect(blockedRoot).rejects.toMatchObject({ code: 'SCOPE_BUSY' });
      expect(
        await database.db
          .selectFrom('receipts.shared_commands')
          .select('outcome')
          .where('command_id', '=', receipt.commandId)
          .execute(),
      ).toEqual([]);
    } finally {
      held.open();
    }
    await pair;
    expect(await invalidation).toEqual({
      kind: 'entered',
      value: { kind: 'invalidated', privacyEpoch: 2, revision: 1 },
    });
    expect(
      await database.db
        .selectFrom('receipts.shared_commands')
        .select('outcome')
        .where('command_id', '=', receipt.commandId)
        .executeTakeFirst(),
    ).toEqual({ outcome: { accepted: true } });
  });

  async function installCommitTrigger(fail: boolean) {
    // A deferred CI trigger pauses the REAL primitive after its writes and NOTIFY, before commit.
    await sql`create function identity.ci_invalidation_commit() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(246001); return new; end $$`.execute(database.db);
    if (fail)
      await sql`create or replace function identity.ci_invalidation_commit() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(246001); raise exception 'CI fixture commit failure'; end $$`.execute(
        database.db,
      );
    await sql`create constraint trigger ci_invalidation_commit after update on identity.universes
      deferrable initially deferred for each row execute function identity.ci_invalidation_commit()`.execute(
      database.db,
    );
  }
  async function dropCommitTrigger() {
    await sql`drop trigger ci_invalidation_commit on identity.universes`.execute(database.db);
    await sql`drop function identity.ci_invalidation_commit()`.execute(database.db);
  }

  it('reads the new peer epoch AFTER waiting even when reset never updates the account row', async () => {
    const a = await seedPerson(database.db),
      b = await seedPerson(database.db);
    const held = gate(),
      entered = gate();
    const rr = createDatabase<Database>({ ...database.settings, poolMax: 1 }, { onIdleClientError: () => undefined });
    await sql`set default_transaction_isolation = 'repeatable read'`.execute(rr.db);
    await installCommitTrigger(false);
    const blocker = other.db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(246001)`.execute(trx);
      entered.open();
      await held.promise;
    });
    await entered.promise;
    const beforeAccount = await database.db
      .selectFrom('identity.accounts')
      .selectAll()
      .where('id', '=', b.accountId)
      .executeTakeFirstOrThrow();
    const invalidation = cases().invalidateOwnAccountAccess(b.authority, 'advance_epoch');
    await expect.poll(waiting).toBeGreaterThan(0);
    const pair = scope(rr.db)(a.authority, async (sc) => {
      const access = await cases(rr.db).fenceAccountPair(sc, b.accountId);
      expect(access.kind).toBe('active');
      if (access.kind !== 'active') throw new Error('missing authority');
      // A prepared result carrying epoch1 must never reach receipt/effect application.
      expect(access.peer.privacyEpoch).toBe(2);
      return access.peer.privacyEpoch === 1 ? 'would_apply_stale' : 'refused_stale';
    });
    try {
      await expect.poll(waiting).toBeGreaterThanOrEqual(2);
    } finally {
      held.open();
    }
    try {
      await blocker;
      await invalidation;
      expect(await pair).toEqual({ kind: 'entered', value: 'refused_stale' });
      expect(
        await database.db.selectFrom('identity.accounts').selectAll().where('id', '=', b.accountId).executeTakeFirst(),
      ).toEqual(beforeAccount);
    } finally {
      await dropCommitTrigger();
      await rr.close();
    }
  });

  it('waits on the lower account before taking SHARE on the higher account', async () => {
    const people = [await seedPerson(database.db), await seedPerson(database.db)].sort((a, b) =>
      a.accountId.localeCompare(b.accountId),
    );
    const lower = people[0]!,
      higher = people[1]!;
    const entered = gate(),
      held = gate();
    const holder = scope(other.db)(lower.authority, async (sc) => {
      await cases(other.db).fenceOwnAccount(sc);
      entered.open();
      await held.promise;
    });
    await entered.promise;
    const pair = scope()(higher.authority, (sc) => cases().fenceAccountPair(sc, lower.accountId));
    try {
      await expect.poll(waiting).toBeGreaterThan(0);
      // NO KEY UPDATE conflicts with SHARE, but not the actor-entry KEY SHARE already on higher.
      // If the pair acquired higher first, NOWAIT would fail instead of reaching this assertion.
      await other.db.transaction().execute(async (trx) => {
        const probe = await trx
          .selectFrom('identity.accounts')
          .select('id')
          .where('id', '=', higher.accountId)
          .forNoKeyUpdate()
          .noWait()
          .executeTakeFirstOrThrow();
        expect(probe.id).toBe(higher.accountId);
      });
    } finally {
      held.open();
      await holder;
    }
    expect(await pair).toMatchObject({ kind: 'entered', value: { kind: 'active' } });
  });

  it('pins READ COMMITTED in both builders despite a REPEATABLE READ connection default', async () => {
    const rr = createDatabase<Database>({ ...database.settings, poolMax: 1 }, { onIdleClientError: () => undefined });
    const p = await seedPerson(database.db);
    try {
      await sql`set default_transaction_isolation = 'repeatable read'`.execute(rr.db);
      const read = async (sc: PersonalScopeTx) =>
        (await sql<{ transaction_isolation: string }>`show transaction_isolation`.execute(transactionOf(sc))).rows[0]
          ?.transaction_isolation;
      expect(await scope(rr.db)(p.authority, read)).toEqual({ kind: 'entered', value: 'read committed' });
      const resolved = makeWithResolvedPersonalScope(rr.db, { lockTimeoutMs: 10_000 });
      expect(
        await resolved(
          () => Promise.resolve({ kind: 'enter', authority: p.authority, context: null }),
          async (sc) => ({ kind: 'commit', value: await read(sc) }),
        ),
      ).toEqual({ kind: 'entered', value: 'read committed' });
    } finally {
      await rr.close();
    }
  });

  it('rolls back epoch/revision and commit-bound NOTIFY on a deferred commit failure', async () => {
    const p = await seedPerson(database.db);
    const listener = await database.pool.connect();
    const notices: string[] = [];
    const barrier = gate();
    listener.on('notification', (event) => {
      if (event.channel === 'ks_access_revoked') notices.push(event.payload ?? '');
      if (event.channel === 'ci_barrier') barrier.open();
    });
    await listener.query('listen ks_access_revoked');
    await listener.query('listen ci_barrier');
    await installCommitTrigger(true);
    try {
      await expect(cases().invalidateOwnAccountAccess(p.authority, 'suspend')).rejects.toThrow(
        'CI fixture commit failure',
      );
      const root = await database.db
        .selectFrom('identity.universes')
        .select(['privacy_epoch', 'revision'])
        .where('id', '=', p.universeId)
        .executeTakeFirst();
      expect(root).toEqual({ privacy_epoch: 1, revision: 0 });
      expect(
        await database.db
          .selectFrom('identity.accounts')
          .select('status')
          .where('id', '=', p.accountId)
          .executeTakeFirst(),
      ).toEqual({ status: 'active' });
      await dropCommitTrigger();
      expect(await cases().invalidateOwnAccountAccess(p.authority, 'advance_epoch')).toMatchObject({
        value: { kind: 'invalidated', privacyEpoch: 2 },
      });
      await sql`select pg_notify('ci_barrier', 'done')`.execute(database.db);
      await barrier.promise;
      expect(notices.map((value) => JSON.parse(value) as unknown)).toEqual([{ v: 1, accountId: p.accountId }]);
    } finally {
      await sql`drop trigger if exists ci_invalidation_commit on identity.universes`.execute(database.db);
      await sql`drop function if exists identity.ci_invalidation_commit()`.execute(database.db);
      await listener.query('unlisten *');
      listener.removeAllListeners('notification');
      listener.release();
    }
  });

  it('serializes reciprocal pair roots and excludes own UPDATE without an account-lock cycle', async () => {
    const a = await seedPerson(database.db),
      b = await seedPerson(database.db),
      root = await seedAsset(database.db);
    const entered = gate(),
      held = gate();
    const one = scope()(a.authority, async (sc) => {
      expect((await cases().fenceAccountPair(sc, b.accountId)).kind).toBe('active');
      await fixtureRoot(sc, root.assetId);
      entered.open();
      await held.promise;
    });
    await entered.promise;
    const two = scope(other.db)(b.authority, async (sc) => {
      expect((await cases(other.db).fenceAccountPair(sc, a.accountId)).kind).toBe('active');
      await fixtureRoot(sc, root.assetId);
      return 'second_committed';
    });
    try {
      await expect.poll(waiting).toBeGreaterThan(0);
    } finally {
      held.open();
    }
    await one;
    expect(await two).toEqual({ kind: 'entered', value: 'second_committed' });
    expect(await cases().invalidateOwnAccountAccess(a.authority, 'advance_epoch')).toMatchObject({
      value: { privacyEpoch: 2 },
    });
  });

  it('rejects upgrades, repeated gates and post-shared acquisition before SQL, and expires the capability', async () => {
    const a = await seedPerson(database.db),
      b = await seedPerson(database.db),
      root = await seedAsset(database.db);
    let closed!: PersonalScopeTx;
    await scope()(a.authority, async (sc) => {
      closed = sc;
      await cases().fenceAccountPair(sc, b.accountId);
      await expect(cases().fenceOwnAccount(sc)).rejects.toBeInstanceOf(LockOrderError);
      await expect(cases().fenceAccountPair(sc, b.accountId)).rejects.toBeInstanceOf(LockOrderError);
      // A SQL error would abort this transaction, so the following statement proves pre-SQL rejection.
      expect((await sql`select 1`.execute(transactionOf(sc))).rows).toHaveLength(1);
    });
    await expect(cases().fenceOwnAccount(closed)).rejects.toBeInstanceOf(ScopeClosedError);
    await scope()(a.authority, async (sc) => {
      await fixtureRoot(sc, root.assetId);
      await expect(cases().fenceAccountPair(sc, b.accountId)).rejects.toBeInstanceOf(LockOrderError);
      await expect(cases().fenceOwnAccount(sc)).rejects.toBeInstanceOf(LockOrderError);
    });
  });

  it('uses monotonic suspension epochs and never replays a receipt after reactivation at the old epoch', async () => {
    const a = await seedPerson(database.db),
      b = await seedPerson(database.db),
      root = await seedAsset(database.db);
    const receipt = key(1);
    await scope()(b.authority, async (sc) => {
      await cases().fenceAccountPair(sc, a.accountId);
      const shared = await fixtureRoot(sc, root.assetId);
      await insertSharedReceipt(shared, receipt);
      await completeSharedReceipt(shared, receipt, { accepted: true });
    });
    expect(await cases().invalidateOwnAccountAccess(b.authority, 'suspend')).toEqual({
      kind: 'entered',
      value: { kind: 'invalidated', privacyEpoch: 2, revision: 1 },
    });
    const system: PersonalAuthority = {
      universeId: b.universeId,
      privacyEpoch: 2,
      actor: { kind: 'system', purpose: 'ci-reactivation' },
    };
    expect(await scope()(system, (sc) => cases().fenceOwnAccount(sc))).toEqual({
      kind: 'entered',
      value: { kind: 'unavailable' },
    });
    // CI-only reactivation follows root -> own account UPDATE and keeps epoch2. No product reactivation endpoint.
    await scope()(system, async (sc) => {
      await transactionOf(sc)
        .selectFrom('identity.accounts')
        .select('id')
        .where('id', '=', b.accountId)
        .forUpdate()
        .execute();
      await transactionOf(sc)
        .updateTable('identity.accounts')
        .set({ status: 'active' })
        .where('id', '=', b.accountId)
        .execute();
    });
    let replayed = false;
    expect(
      await scope()(b.authority, () => {
        replayed = true;
        return Promise.resolve();
      }),
    ).toEqual({ kind: 'refused', refusal: { kind: 'epoch_changed', currentEpoch: 2 } });
    expect(replayed).toBe(false);
    await scope()({ ...b.authority, privacyEpoch: 2 }, async (sc) => {
      await cases().fenceAccountPair(sc, a.accountId);
      const shared = await fixtureRoot(sc, root.assetId);
      expect(
        await findSharedReceipt(shared, { ...receipt, requestHash: requestHash('fixture.pair', { epoch: 2 }) }),
      ).toEqual({ kind: 'key_reused' });
    });
  });

  it('bounds account waits and writes no shared receipt/effect on timeout', async () => {
    const a = await seedPerson(database.db),
      b = await seedPerson(database.db);
    const held = gate(),
      entered = gate();
    const holder = scope(other.db)(b.authority, async (sc) => {
      await cases(other.db).fenceOwnAccount(sc);
      entered.open();
      await held.promise;
    });
    await entered.promise;
    let applied = false;
    try {
      await expect(
        scope(database.db, 150)(a.authority, async (sc) => {
          await cases().fenceAccountPair(sc, b.accountId);
          applied = true;
        }),
      ).rejects.toMatchObject({ code: '55P03' });
      expect(applied).toBe(false);
    } finally {
      held.open();
      await holder;
    }
  });

  it('refuses self/missing peers, actor mismatch, inactive system ownership, and counter overflow without writes', async () => {
    const a = await seedPerson(database.db);
    for (const peer of [a.accountId, randomUUID(), 'invalid'])
      expect(await scope()(a.authority, (sc) => cases().fenceAccountPair(sc, peer))).toEqual({
        kind: 'entered',
        value: { kind: 'unavailable' },
      });
    expect(
      await scope()({ ...a.authority, actor: { kind: 'account', accountId: randomUUID() } }, () =>
        Promise.resolve('wrong'),
      ),
    ).toEqual({ kind: 'refused', refusal: { kind: 'account_mismatch' } });
    const max = await seedPerson(database.db, { privacyEpoch: 2_147_483_647 });
    expect(await cases().invalidateOwnAccountAccess(max.authority, 'advance_epoch')).toEqual({
      kind: 'entered',
      value: { kind: 'counter_exhausted' },
    });
    await database.db
      .updateTable('identity.universes')
      .set({ revision: 2_147_483_647 })
      .where('id', '=', a.universeId)
      .execute();
    expect(await cases().invalidateOwnAccountAccess(a.authority, 'suspend')).toEqual({
      kind: 'entered',
      value: { kind: 'counter_exhausted' },
    });
    expect(
      await database.db
        .selectFrom('identity.accounts')
        .select('status')
        .where('id', '=', a.accountId)
        .executeTakeFirst(),
    ).toEqual({ status: 'active' });
    const tokens = { useCases: Symbol('ci') };
    const useCases = cases();
    expect(
      accountAccessProviders(tokens).map(({ provide, inject, useFactory }) => ({
        provide,
        inject,
        useCase: useFactory(useCases),
      })),
    ).toEqual([
      { provide: FENCE_ACCOUNT_PAIR, inject: [tokens.useCases], useCase: useCases.fenceAccountPair },
      { provide: FENCE_OWN_ACCOUNT, inject: [tokens.useCases], useCase: useCases.fenceOwnAccount },
      { provide: READ_RECORDING_LIFECYCLE, inject: [tokens.useCases], useCase: useCases.readRecordingLifecycle },
      {
        provide: INVALIDATE_OWN_ACCOUNT_ACCESS,
        inject: [tokens.useCases],
        useCase: useCases.invalidateOwnAccountAccess,
      },
    ]);
  });
});
