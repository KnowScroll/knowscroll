import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NestedTransactionError,
  ScopeBusyError,
  ScopeClosedError,
  advanceScopeRevision,
  createDatabase,
  makeWithPersonalScope,
  transactionOf,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import type { PersonalScopeTx } from '@knowscroll/backend/modules/identity';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson } from '../support/fixtures.js';

describe('withPersonalScope (real database)', () => {
  let database: TestDatabase<Database>;
  let other: TestDatabase<Database>['db'];
  let closeOther: () => Promise<void>;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('personal_scope');
    // A second pool: the race tests need two independent connections.
    const second = createDatabase<Database>(database.settings, { onIdleClientError: () => undefined });
    other = second.db;
    closeOther = () => second.close();
  });
  afterAll(async () => {
    await closeOther();
    await database.drop();
  });

  it('enters for the owner at the current epoch and commits the work', async () => {
    const person = await seedPerson(database.db);
    const withPersonalScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
    const outcome = await withPersonalScope(person.authority, async (scope) => advanceScopeRevision(scope));
    expect(outcome).toEqual({ kind: 'entered', value: 1 });
  });

  it('refuses a missing universe, a stale epoch, another account and a suspended universe', async () => {
    const withPersonalScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
    const person = await seedPerson(database.db);
    const work = () => Promise.resolve('ran');
    expect(
      await withPersonalScope({ ...person.authority, universeId: '00000000-0000-4000-8000-000000000000' }, work),
    ).toEqual({ kind: 'refused', refusal: { kind: 'universe_missing' } });
    expect(await withPersonalScope({ ...person.authority, privacyEpoch: 2 }, work)).toEqual({
      kind: 'refused',
      refusal: { kind: 'epoch_changed', currentEpoch: 1 },
    });
    expect(
      await withPersonalScope(
        { ...person.authority, actor: { kind: 'account', accountId: '00000000-0000-4000-8000-000000000001' } },
        work,
      ),
    ).toEqual({
      kind: 'refused',
      refusal: { kind: 'account_mismatch' },
    });
    await database.db
      .updateTable('identity.universes')
      .set({ status: 'suspended' })
      .where('id', '=', person.universeId)
      .execute();
    expect(await withPersonalScope(person.authority, work)).toEqual({
      kind: 'refused',
      refusal: { kind: 'universe_suspended' },
    });
  });

  it('makes a second connection wait for the lock and recheck the epoch after waiting', async () => {
    const person = await seedPerson(database.db);
    const first = makeWithPersonalScope(database.db, { lockTimeoutMs: 10_000 });
    const second = makeWithPersonalScope(other, { lockTimeoutMs: 10_000 });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const order: string[] = [];

    const firstRun = first(person.authority, async (scope) => {
      entered();
      await held;
      // A privacy reset committed by the lock holder: the waiter's authority is now stale.
      await transactionOf(scope)
        .updateTable('identity.universes')
        .set({ privacy_epoch: 2 })
        .where('id', '=', person.universeId)
        .execute();
      order.push('first-commits');
    });
    await firstEntered;
    const secondRun = second(person.authority, () => {
      order.push('second-entered');
      return Promise.resolve();
    });
    // The second transaction is blocked on the universe row while the first holds it.
    await expect.poll(() => waitingOnLock(database.db), { timeout: 5_000 }).toBeGreaterThan(0);
    order.push('second-waiting');
    release();
    await firstRun;
    expect(await secondRun).toEqual({ kind: 'refused', refusal: { kind: 'epoch_changed', currentEpoch: 2 } });
    expect(order).toEqual(['second-waiting', 'first-commits']);
  });

  it('lets the waiter see the revision committed by the lock holder', async () => {
    const person = await seedPerson(database.db);
    const first = makeWithPersonalScope(database.db, { lockTimeoutMs: 10_000 });
    const second = makeWithPersonalScope(other, { lockTimeoutMs: 10_000 });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const firstRun = first(person.authority, async (scope) => {
      entered();
      await held;
      return advanceScopeRevision(scope);
    });
    await firstEntered;
    const secondRun = second(person.authority, (scope) => Promise.resolve(scope.revisionAtEntry));
    await expect.poll(() => waitingOnLock(database.db), { timeout: 5_000 }).toBeGreaterThan(0);
    release();
    expect(await firstRun).toEqual({ kind: 'entered', value: 1 });
    expect(await secondRun).toEqual({ kind: 'entered', value: 1 });
  });

  it('gives up with ScopeBusyError when the lock is not granted in time', async () => {
    const person = await seedPerson(database.db);
    const holder = makeWithPersonalScope(database.db, { lockTimeoutMs: 10_000 });
    const impatient = makeWithPersonalScope(other, { lockTimeoutMs: 200 });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holding = holder(person.authority, async () => {
      entered();
      await held;
    });
    await firstEntered;
    await expect(impatient(person.authority, () => Promise.resolve())).rejects.toBeInstanceOf(ScopeBusyError);
    release();
    await holding;
  });

  it('refuses a nested guarded transaction and a scope used after its transaction', async () => {
    const person = await seedPerson(database.db);
    const withPersonalScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
    await expect(
      withPersonalScope(person.authority, () => withPersonalScope(person.authority, () => Promise.resolve())),
    ).rejects.toBeInstanceOf(NestedTransactionError);
    let leaked: PersonalScopeTx | undefined;
    await withPersonalScope(person.authority, (scope) => {
      leaked = scope;
      return Promise.resolve();
    });
    expect(() => transactionOf(leaked as PersonalScopeTx)).toThrow(ScopeClosedError);
  });
});

/** Backends currently waiting on a row lock in this database. */
async function waitingOnLock(db: TestDatabase<Database>['db']): Promise<number> {
  const result = await sql<{ waiting: number }>`
    select count(*)::int as waiting from pg_stat_activity
    where datname = current_database() and wait_event_type = 'Lock'`.execute(db);
  return result.rows[0]?.waiting ?? 0;
}
