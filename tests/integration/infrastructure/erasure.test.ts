import { socialUseCases } from '@knowscroll/backend/modules/social/nest-providers';
import { accountAccessUseCases } from '@knowscroll/backend/modules/identity/nest-providers';
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { personalStores } from '@knowscroll/backend/erasure-registry';
import {
  checkErasureInventory,
  checkQueuePayloadStores,
  eraseUniverse,
  erasureRegistry,
} from '@knowscroll/backend/infrastructure/erasure';
import { defineQueue } from '@knowscroll/backend/infrastructure/jobs';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { releaseQueues } from '@knowscroll/backend/job-queues';
import { makeAttemptLedger } from '@knowscroll/backend/reasoning/nest-providers';
import { z } from 'zod';
import { everyStoreSeeder } from '../support/every-store.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson } from '../support/fixtures.js';
import { recordingPerson } from '../support/recording-person.js';

/** CI fixture: a run descriptor and a reservation written straight through the ledger port. */
function fixtureRunDescriptor(id: string) {
  return {
    id,
    ownerModule: 'fixture',
    purpose: 'fixture',
    roleId: 'fixture.erasure',
    roleVersion: 'v1',
    policyVersion: 'fixture.v1',
    provider: 'fixture',
    model: 'fixture',
    contextBundleRef: 'fixture.bundle:erasure',
    contextRefs: ['fixture:item'],
  };
}

function fixtureReservation(id: string, runId: string, label: string) {
  // The database recomputes the hash of the stored bytes (a CHECK): the hash is the real one.
  const requestBody = new TextEncoder().encode(`{"fixture":"erasure-${label}"}`);
  return {
    id,
    runId,
    step: 'primary',
    provider: 'fixture',
    model: 'fixture',
    roleId: 'fixture.erasure',
    roleVersion: 'v1',
    promptVersion: 'hp-fixture',
    requestHash: createHash('sha256').update(requestBody).digest('hex'),
    requestBody,
    maxOutputTokens: 16,
    reservedTokens: 37,
    requestRetentionSeconds: 3_600,
  };
}

/** Rows per registered personal table for one universe. */
async function personalRowCountsIn(
  db: TestDatabase<Database>['db'],
  universeId: string,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const declaration of personalStores) {
    for (const table of declaration.tables) {
      const result = await sql<{
        n: number;
      }>`select count(*)::int as n from ${sql.table(`${table.schema}.${table.table}`)} where universe_id = ${universeId}`.execute(
        db,
      );
      counts[`${table.schema}.${table.table}`] = result.rows[0]?.n ?? 0;
    }
  }
  return counts;
}

describe('the erasure registry (real database)', () => {
  let database: TestDatabase<Database>;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('erasure');
  });
  afterAll(async () => {
    await database.drop();
  });

  const personalRowCounts = (universeId: string) => personalRowCountsIn(database.db, universeId);

  it('declares every personal table, account-linked column and queue payload store, with RESTRICT references to the root', async () => {
    expect(await checkErasureInventory(database.db, personalStores)).toEqual([]);
    expect(checkQueuePayloadStores(releaseQueues, personalStores)).toEqual([]);
  });

  it('requires both actual personal-role account links in the migrated schema inventory', async () => {
    for (const module of ['planner', 'geography']) {
      expect(personalStores.find((owner) => owner.module === module)?.accountColumns).toContainEqual({
        schema: module,
        table: 'runs',
        column: 'recording_account_id',
      });
    }
    const omitted = personalStores.map((owner) =>
      owner.module === 'planner' || owner.module === 'geography'
        ? {
            ...owner,
            accountColumns: owner.accountColumns?.filter((column) => column.column !== 'recording_account_id'),
          }
        : owner,
    );
    expect(await checkErasureInventory(database.db, omitted)).toEqual([
      'geography.runs.recording_account_id links to an account or person but no module declares it',
      'planner.runs.recording_account_id links to an account or person but no module declares it',
    ]);
  });

  it('fails the inventory for an unregistered personal table, a cascading reference and an undeclared account link', async () => {
    await sql`create table experience.forgotten_personal (universe_id uuid not null references identity.universes (id) on delete cascade, owner_account_id uuid)`.execute(
      database.db,
    );
    try {
      expect(await checkErasureInventory(database.db, personalStores)).toEqual([
        'experience.forgotten_personal has a universe_id column but no module declares it in the erasure registry',
        'experience.forgotten_personal.owner_account_id links to an account or person but no module declares it',
      ]);
      const declared = erasureRegistry([
        ...personalStores,
        {
          module: 'fixture',
          tables: [{ schema: 'experience', table: 'forgotten_personal', ownerColumn: 'universe_id' }],
          nonRowStores: [],
          erase: () => Promise.reject(new Error('unused')),
        },
      ]);
      expect(await checkErasureInventory(database.db, declared)).toContain(
        'experience.forgotten_personal does not reference identity.universes from universe_id with ON DELETE RESTRICT',
      );
    } finally {
      await sql`drop table experience.forgotten_personal`.execute(database.db);
    }
  });

  it('finds owner columns by foreign key and by person naming, whatever they are called', async () => {
    await sql`create table experience.forgotten_links (
      created_by uuid references identity.accounts (id) on delete restrict,
      home uuid references identity.universes (id) on delete restrict,
      subject_person_id uuid)`.execute(database.db);
    try {
      expect(await checkErasureInventory(database.db, personalStores)).toEqual([
        'experience.forgotten_links.created_by links to an account or person but no module declares it',
        'experience.forgotten_links.home links to an account or person but no module declares it',
        'experience.forgotten_links.subject_person_id links to an account or person but no module declares it',
      ]);
      const declared = erasureRegistry([
        ...personalStores,
        {
          module: 'fixture',
          tables: [],
          accountColumns: ['created_by', 'home', 'subject_person_id'].map((column) => ({
            schema: 'experience',
            table: 'forgotten_links',
            column,
          })),
          nonRowStores: [],
          erase: () => Promise.reject(new Error('unused')),
        },
      ]);
      expect(await checkErasureInventory(database.db, declared)).toEqual([]);
    } finally {
      await sql`drop table experience.forgotten_links`.execute(database.db);
    }
  });

  it('finds a person reference by name when it has no foreign key', async () => {
    await sql`create table experience.forgotten_refs (peer_universe_id uuid, owner_id uuid, member_id uuid)`.execute(
      database.db,
    );
    try {
      expect(await checkErasureInventory(database.db, personalStores)).toEqual([
        'experience.forgotten_refs.member_id links to an account or person but no module declares it',
        'experience.forgotten_refs.owner_id links to an account or person but no module declares it',
        'experience.forgotten_refs.peer_universe_id links to an account or person but no module declares it',
      ]);
      const declared = erasureRegistry([
        ...personalStores,
        {
          module: 'fixture',
          tables: [],
          accountColumns: ['peer_universe_id', 'owner_id', 'member_id'].map((column) => ({
            schema: 'experience',
            table: 'forgotten_refs',
            column,
          })),
          nonRowStores: [],
          erase: () => Promise.reject(new Error('unused')),
        },
      ]);
      expect(await checkErasureInventory(database.db, declared)).toEqual([]);
    } finally {
      await sql`drop table experience.forgotten_refs`.execute(database.db);
    }
  });

  it('finds a child table that reaches a personal root only through another table', async () => {
    await sql`create table composer.forgotten_child (
      decision_id uuid primary key references composer.decisions (id) on delete cascade)`.execute(database.db);
    try {
      expect(await checkErasureInventory(database.db, personalStores)).toEqual([
        'composer.forgotten_child reaches a personal root through foreign keys but no module declares it',
      ]);
      const declared = erasureRegistry([
        ...personalStores,
        {
          module: 'fixture',
          tables: [],
          accountTables: [{ schema: 'composer', table: 'forgotten_child', ownerColumn: 'decision_id' }],
          nonRowStores: [],
          erase: () => Promise.reject(new Error('unused')),
        },
      ]);
      expect(await checkErasureInventory(database.db, declared)).toEqual([]);
    } finally {
      await sql`drop table composer.forgotten_child`.execute(database.db);
    }
  });

  it('inventories Social account lifetime stores, retains them on exploration clear, and rejects a nonexistent declared account table', async () => {
    const a = await seedPerson(database.db),
      b = await seedPerson(database.db);
    const withScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 });
    const access = accountAccessUseCases({ db: database.db, lockTimeoutMs: 5000 });
    const social = socialUseCases({ withScope, fencePair: access.fenceAccountPair, fenceOwn: access.fenceOwnAccount });
    await social.setProfile(a.authority, {
      version: 'sharing.v1',
      commandId: randomUUID(),
      expectedProfileRevision: 0,
      handle: 'erasure.owner',
      displayName: 'Owner',
    });
    await social.setProfile(b.authority, {
      version: 'sharing.v1',
      commandId: randomUUID(),
      expectedProfileRevision: 0,
      handle: 'erasure.friend',
      displayName: 'Friend',
    });
    const profile = await social.readProfile(b.authority);
    if (profile.kind !== 'ok' || profile.value.status !== 'claimed') throw new Error('CI Social profile');
    await social.command(a.authority, 'request', {
      version: 'sharing.v1',
      commandId: randomUUID(),
      expectedPeerPersonId: profile.value.person.personId,
      expectedPairRevision: 0,
      target: { kind: 'handle', handle: 'erasure.friend' },
    });
    await social.createInvite(a.authority, {
      version: 'sharing.v1',
      commandId: randomUUID(),
      expectedInviteRevision: 0,
    });
    const accountBefore = await Promise.all([
      database.db.selectFrom('social.invites').selectAll().execute(),
      database.db.selectFrom('social.roster_heads').selectAll().execute(),
      database.db.selectFrom('social.roster_entries').selectAll().execute(),
    ]);
    const before = await database.db.selectFrom('social.pairs').selectAll().execute();
    expect(before.length).toBeGreaterThan(0);
    await withScope(a.authority, (scope) => eraseUniverse(scope, personalStores));
    expect(await database.db.selectFrom('social.pairs').selectAll().execute()).toEqual(before);
    expect(
      await Promise.all([
        database.db.selectFrom('social.invites').selectAll().execute(),
        database.db.selectFrom('social.roster_heads').selectAll().execute(),
        database.db.selectFrom('social.roster_entries').selectAll().execute(),
      ]),
    ).toEqual(accountBefore);

    expect(
      (await social.readPair(a.authority, { version: 'sharing.v1', peerPersonId: profile.value.person.personId })).kind,
    ).toBe('ok');
    expect(await checkErasureInventory(database.db, personalStores)).toEqual([]);
    const nonexistent = erasureRegistry([
      ...personalStores,
      {
        module: 'ci_account_missing',
        tables: [],
        accountTables: [{ schema: 'social', table: 'missing_account_table', ownerColumn: 'account_id' }],
        nonRowStores: [],
        erase: () => Promise.reject(new Error('unused')),
      },
    ]);
    expect(await checkErasureInventory(database.db, nonexistent)).toEqual([
      'social.missing_account_table is declared as an account table but does not exist',
    ]);
  });

  it('fails when a queue carrying universeId has no declared payload store', () => {
    const queue = defineQueue({
      name: 'fixture.personal-payload',
      purpose: 'CI fixture',
      payload: z.object({ v: z.literal(1), universeId: z.uuid() }),
      policy: {
        expireInSeconds: 60,
        retryLimit: 0,
        retryDelaySeconds: 1,
        retryBackoff: false,
        retentionSeconds: 60,
        deleteAfterSeconds: 60,
        deadLetter: false,
      },
      consumer: { localConcurrency: 1, pollingIntervalSeconds: 1 },
    });
    expect(checkQueuePayloadStores([queue], personalStores)).toEqual([
      'queue fixture.personal-payload carries universeId in its payload but no module declares the store pgboss/fixture.personal-payload',
    ]);
  });

  it('refuses a table declared by two modules', () => {
    const [first] = personalStores;
    if (first === undefined) throw new Error('empty registry');
    expect(() => erasureRegistry([first, { ...first, module: 'duplicate' }])).toThrow('declared by two modules');
  });

  it('erases one universe from every registered store and leaves another universe untouched', async () => {
    const erased = await recordingPerson(database);
    const kept = await recordingPerson(database);
    const withPersonalScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
    const seeder = await everyStoreSeeder(database);
    const seed = seeder.seed;
    try {
      await seed(erased);
      await seed(kept);
      const before = {
        erased: await personalRowCounts(erased.universeId),
        kept: await personalRowCounts(kept.universeId),
      };
      // Current birth and channel certificates are real. Every registered personal store,
      // including labelled historical coexistence rows, must contain data before full erasure.
      expect(Object.values(before.erased).every((count) => count > 0)).toBe(true);
      expect(before.erased['identity.recording_lifecycle_witnesses']).toBe(1);
      expect(before.erased['experience.recording_channel_certificates']).toBeGreaterThan(0);
      const reports = await withPersonalScope(erased.authority, (scope) => eraseUniverse(scope, personalStores));
      expect(reports.kind === 'entered' && reports.value.every((report) => report.status === 'completed')).toBe(true);
      const after = {
        erased: await personalRowCounts(erased.universeId),
        kept: await personalRowCounts(kept.universeId),
      };
      expect(Object.values(after.erased).every((count) => count === 0)).toBe(true);
      expect(after.kept).toEqual(before.kept);
    } finally {
      await seeder.close();
    }
    const jobs = async (universeId: string) =>
      (
        await sql<{
          n: number;
        }>`select count(*)::int as n from pgboss.job where data ->> 'universeId' = ${universeId}`.execute(database.db)
      ).rows[0]?.n;
    expect(await jobs(erased.universeId)).toBe(0);
    expect(await jobs(kept.universeId)).toBeGreaterThan(0);
  });

  it('keeps attempts whose outcome is still open, and reports the erasure as pending', async () => {
    const person = await seedPerson(database.db);
    const withPersonalScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
    const ledger = makeAttemptLedger(database.db);
    const attemptId = randomUUID();
    await withPersonalScope(person.authority, async (scope) => {
      const runId = randomUUID();
      await ledger.admitRun(scope, fixtureRunDescriptor(runId));
      await ledger.reserve(scope, fixtureReservation(attemptId, runId, 'b'));
      await ledger.commitDispatch(scope, attemptId, {
        dispatchId: randomUUID(),
        dispatchedBy: 'ci-fixture',
        quota: { verdict: 'not_applicable', intervalRemainingPercent: null, weeklyRemainingPercent: null },
      });
    });
    const reports = await withPersonalScope(person.authority, (scope) => eraseUniverse(scope, personalStores));
    expect(
      reports.kind === 'entered' ? reports.value.find((report) => report.module === 'reasoning') : undefined,
    ).toMatchObject({ status: 'pending' });
    const left = await personalRowCounts(person.universeId);
    expect({
      attempts: left['reasoning.external_attempts'],
      runs: left['reasoning.business_runs'],
      requests: left['reasoning.protected_requests'],
    }).toEqual({
      attempts: 1,
      runs: 1,
      // The open attempt's request bytes are private context: erased even while it is unresolved.
      requests: 0,
    });
  });
});

import { contentReelStores } from '@knowscroll/backend/modules/content/nest-providers';
describe('Reel order stores (real schema)', () => {
  let world: TestDatabase<Database>;
  beforeAll(async () => {
    world = await createTestDatabase<Database>('reel_inventory');
  });
  afterAll(async () => {
    await world.drop();
  });
  it('declares every actual Reel table and proves none depends on an account or universe, directly or through a key', async () => {
    const declarations = contentReelStores.map((store) => store.table).sort();
    const actual = (
      await sql<{
        name: string;
      }>`select n.nspname||'.'||c.relname name from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where c.relkind='r' and n.nspname='content' and c.relname like 'reel\_%' order by 1`.execute(world.db)
    ).rows.map((row) => row.name);
    expect(actual).toEqual(declarations);
    for (const table of declarations) {
      const dependencies = (
        await sql<{ name: string }>`with recursive owned(oid) as (
     select to_regclass(${table})::oid union select f.confrelid from pg_catalog.pg_constraint f join owned o on o.oid=f.conrelid where f.contype='f')
     select distinct n.nspname||'.'||c.relname name from owned o join pg_catalog.pg_class c on c.oid=o.oid
     join pg_catalog.pg_namespace n on n.oid=c.relnamespace left join pg_catalog.pg_attribute a on a.attrelid=c.oid and not a.attisdropped and a.attnum>0
     where (n.nspname='identity' and c.relname in ('accounts','universes')) or a.attname='universe_id' or a.attname='account_id' or a.attname like '%\_account_id'`.execute(
          world.db,
        )
      ).rows;
      expect(dependencies, table).toEqual([]);
    }
  });
});

import { contentRegionStores } from '@knowscroll/backend/modules/content/nest-providers';
describe('Region shared projection inventory (real schema, Actions only)', () => {
  let world: TestDatabase<Database>;
  beforeAll(async () => {
    world = await createTestDatabase<Database>('region_inventory');
  });
  afterAll(async () => {
    await world.drop();
  });
  it('declares the actual projection and proves no direct/transitive personal dependency', async () => {
    expect(contentRegionStores.map((x) => x.table)).toEqual(['content.region_bindings']);
    const actual = await sql<{
      name: string;
    }>`select n.nspname||'.'||c.relname name from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname='content' and c.relname='region_bindings'`.execute(
      world.db,
    );
    expect(actual.rows.map((x) => x.name)).toEqual(contentRegionStores.map((x) => x.table));
    const rows = await sql<{ name: string }>`with recursive owned(oid) as (
      select to_regclass('content.region_bindings')::oid union select f.confrelid from pg_catalog.pg_constraint f join owned o on o.oid=f.conrelid where f.contype='f')
      select distinct n.nspname||'.'||c.relname name from owned o join pg_catalog.pg_class c on c.oid=o.oid join pg_catalog.pg_namespace n on n.oid=c.relnamespace left join pg_catalog.pg_attribute a on a.attrelid=c.oid and not a.attisdropped and a.attnum>0
      where (n.nspname='identity' and c.relname in('accounts','universes')) or a.attname='universe_id' or a.attname='account_id' or a.attname like '%\_account_id'`.execute(
      world.db,
    );
    expect(rows.rows).toEqual([]);
    const omitted = erasureRegistry(
      personalStores.map((x) =>
        x.module === 'experience'
          ? { ...x, tables: x.tables.filter((t) => t.table !== 'offer_region_constraints') }
          : x,
      ),
    );
    expect(await checkErasureInventory(world.db, omitted)).toContain(
      'experience.offer_region_constraints has a universe_id column but no module declares it in the erasure registry',
    );
  });
});
