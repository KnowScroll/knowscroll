import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ScopeBusyError,
  advanceScopeRevision,
  createDatabase,
  makeWithDryRunPersonalScope,
  makeWithPersonalScope,
  transactionOf,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import { withScopeAtCurrentEpoch } from '@knowscroll/backend/modules/identity';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson } from '../support/fixtures.js';

/**
 * The scope the dry-run commands run in (#674, D-411): the root lock of an ordinary personal scope, then READ ONLY,
 * and always rolled back. Evidence label: real PostgreSQL; no provider is called.
 */
describe('the dry-run personal scope (real database)', () => {
  let database: TestDatabase<Database>;
  let other: TestDatabase<Database>['db'];
  let closeOther: () => Promise<void>;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('dry_run_scope');
    const second = createDatabase<Database>(database.settings, { onIdleClientError: () => undefined });
    other = second.db;
    closeOther = () => second.close();
  });
  afterAll(async () => {
    await closeOther();
    await database.drop();
  });

  const revisionOf = async (universeId: string) =>
    (
      await database.db
        .selectFrom('identity.universes')
        .select('revision')
        .where('id', '=', universeId)
        .executeTakeFirstOrThrow()
    ).revision;

  it('hands back what the work returns and leaves the universe as it was', async () => {
    const person = await seedPerson(database.db);
    const dryRun = makeWithDryRunPersonalScope(database.db, { lockTimeoutMs: 5_000 });
    const outcome = await dryRun(person.authority, async (scope) => {
      const row = await transactionOf(scope)
        .selectFrom('identity.universes')
        .select('revision')
        .where('id', '=', scope.authority.universeId)
        .executeTakeFirstOrThrow();
      return { revision: row.revision, atEntry: scope.revisionAtEntry };
    });
    expect(outcome).toEqual({ kind: 'entered', value: { revision: 0, atEntry: 0 } });
    expect(await revisionOf(person.universeId)).toBe(0);
  });

  it('cuts any one statement off after five seconds, set locally right after READ ONLY', async () => {
    const person = await seedPerson(database.db);
    const dryRun = makeWithDryRunPersonalScope(database.db, { lockTimeoutMs: 5_000 });
    const inside = await dryRun(person.authority, async (scope) => {
      const row = await sql<{ timeout: string; readOnly: string }>`
        select current_setting('statement_timeout') as timeout, current_setting('transaction_read_only') as "readOnly"`.execute(
        transactionOf(scope),
      );
      return row.rows[0];
    });
    expect(inside).toEqual({ kind: 'entered', value: { timeout: '5s', readOnly: 'on' } });
    // Local to the transaction: the pool's own setting is untouched afterwards.
    const after = await sql<{ timeout: string }>`select current_setting('statement_timeout') as timeout`.execute(
      database.db,
    );
    expect(after.rows[0]!.timeout).not.toBe('5s');
  });

  it('refuses every write with PostgreSQL 25006 and changes nothing', async () => {
    const person = await seedPerson(database.db);
    const dryRun = makeWithDryRunPersonalScope(database.db, { lockTimeoutMs: 5_000 });
    await expect(dryRun(person.authority, (scope) => advanceScopeRevision(scope))).rejects.toMatchObject({
      code: '25006',
    });
    await expect(
      dryRun(person.authority, async (scope) => {
        await sql`insert into identity.accounts (id) values (gen_random_uuid())`.execute(transactionOf(scope));
      }),
    ).rejects.toMatchObject({ code: '25006' });
    expect(await revisionOf(person.universeId)).toBe(0);
  });

  it('refuses a row lock inside the work, which a READ ONLY transaction cannot take', async () => {
    const person = await seedPerson(database.db);
    const dryRun = makeWithDryRunPersonalScope(database.db, { lockTimeoutMs: 5_000 });
    await expect(
      dryRun(person.authority, async (scope) => {
        await sql`select id from identity.accounts where id = ${person.accountId}::uuid for share`.execute(
          transactionOf(scope),
        );
      }),
    ).rejects.toMatchObject({ code: '25006' });
  });

  it('refuses a missing universe, a stale epoch and a suspended universe as the ordinary scope does', async () => {
    const dryRun = makeWithDryRunPersonalScope(database.db, { lockTimeoutMs: 5_000 });
    const person = await seedPerson(database.db);
    const work = () => Promise.resolve('ran');
    expect(await dryRun({ ...person.authority, universeId: '00000000-0000-4000-8000-000000000000' }, work)).toEqual({
      kind: 'refused',
      refusal: { kind: 'universe_missing' },
    });
    expect(await dryRun({ ...person.authority, privacyEpoch: 2 }, work)).toEqual({
      kind: 'refused',
      refusal: { kind: 'epoch_changed', currentEpoch: 1 },
    });
    await database.db
      .updateTable('identity.universes')
      .set({ status: 'suspended' })
      .where('id', '=', person.universeId)
      .execute();
    expect(await dryRun(person.authority, work)).toEqual({ kind: 'refused', refusal: { kind: 'universe_suspended' } });
  });

  it('waits behind the personal root like a read, and gives up at the lock timeout', async () => {
    const person = await seedPerson(database.db);
    const ordinary = makeWithPersonalScope(other, { lockTimeoutMs: 5_000 });
    const dryRun = makeWithDryRunPersonalScope(database.db, { lockTimeoutMs: 250 });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const holding = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holder = ordinary(person.authority, async () => {
      entered();
      await held;
    });
    await holding;
    try {
      await expect(dryRun(person.authority, () => Promise.resolve('ran'))).rejects.toBeInstanceOf(ScopeBusyError);
    } finally {
      release();
      await holder;
    }
    expect(await dryRun(person.authority, () => Promise.resolve('ran'))).toEqual({ kind: 'entered', value: 'ran' });
  });

  it('finds the current epoch of a universe named without one, and runs the work once', async () => {
    const person = await seedPerson(database.db, { privacyEpoch: 3 });
    const dryRun = makeWithDryRunPersonalScope(database.db, { lockTimeoutMs: 5_000 });
    let runs = 0;
    const outcome = await withScopeAtCurrentEpoch(dryRun, person.universeId, 'ci.dry-run', (scope) => {
      runs += 1;
      return Promise.resolve(scope.authority.privacyEpoch);
    });
    expect(outcome).toEqual({ kind: 'entered', value: 3 });
    expect(runs).toBe(1);
  });
});
