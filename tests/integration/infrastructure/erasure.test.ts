import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composeEncounter } from '@knowscroll/backend/modules/composer';
import { makeComposerStore } from '@knowscroll/backend/modules/composer/nest-providers';
import { fixtureComposerSnapshot } from '../support/composer.js';
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
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { evidenceUseCase } from '../support/evidence.js';
import { experienceUseCases } from '../support/experience.js';
import { seedAsset, seedPerson, type FixturePerson } from '../support/fixtures.js';
import { activatedAgo, coverage, dwell, event, openActive } from '../support/observations.js';
import { admitStarter, scrollUseCases } from '../support/scroll.js';

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

  it('fails the inventory for an unregistered personal table, a cascading reference and an undeclared account link', async () => {
    await sql`create table experience.forgotten_personal (universe_id uuid not null references identity.universes (id) on delete cascade, owner_account_id uuid)`.execute(
      database.db,
    );
    try {
      expect(await checkErasureInventory(database.db, personalStores)).toEqual([
        'experience.forgotten_personal has a universe_id column but no module declares it in the erasure registry',
        'experience.forgotten_personal.owner_account_id links to an account but no module declares it',
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
    const erased = await seedPerson(database.db);
    const kept = await seedPerson(database.db);
    const asset = await seedAsset(database.db);
    const useCases = await experienceUseCases(database);
    const scroll = await scrollUseCases(database);
    const starter = await admitStarter(scroll.importScroll);
    // Explicit CI attribution fixture for exercising personal topic-row erasure; no runtime taxonomy inference.
    await database.db
      .insertInto('content.encounter_topics')
      .values({
        asset_id: starter.assetId,
        asset_revision: starter.revision,
        topic_id: 'ci.erasure.topic',
        role: 'primary',
        weight: 1,
      })
      .execute();
    const applyEvidence = evidenceUseCase(database);
    const withPersonalScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
    const ledger = makeAttemptLedger(database.db);
    /** A person's reading of the starter Scroll: exposure, observations and a projected evidence revision. */
    const seedReading = async (person: FixturePerson) => {
      const exposure = await openActive(scroll, person, starter);
      await activatedAgo(database.db, exposure.exposureId, 30);
      const blocks = ['intro-look-up', 'intro-short-version', 'sunlight-prism'];
      const ingested = await scroll.ingestObservations(person.authority, {
        instrumentationVersion: 1,
        events: [event(exposure, coverage(blocks, 3_000)), event(exposure, dwell([0, 9_000]))],
      });
      if (ingested.kind !== 'ingested' || ingested.accepted !== 2) throw new Error('fixture observations refused');
      const projected = await scroll.projectScrollReading({
        v: 1,
        universeId: person.universeId,
        privacyEpoch: 1,
        exposureId: exposure.exposureId,
      });
      if (projected.kind !== 'applied') throw new Error('fixture projection skipped');
    };
    const seed = async (person: FixturePerson) => {
      await withPersonalScope(person.authority, (scope) =>
        makeComposerStore({ isOperator: () => true }).persistComposerDecision(
          scope,
          { decisionId: randomUUID(), commandId: randomUUID() },
          composeEncounter(fixtureComposerSnapshot(person.authority)),
        ),
      );
      await seedReading(person);
      const opened = await scroll.navigate(person.authority, {
        commandId: randomUUID(),
        target: { kind: 'return', assetId: starter.assetId, assetRevision: starter.revision },
        capabilities: {
          documentSchemas: ['scroll-document.v1'],
          blocks: { fallback: [1], paragraph: [1], subheading: [1] },
        },
      });
      if (opened.kind !== 'accepted' || opened.outcome.status !== 'ready')
        throw new Error('fixture navigation refused');
      const o = opened.outcome;
      const activated = await scroll.activateOffer(person.authority, {
        commandId: randomUUID(),
        target: {
          kind: 'offer',
          sessionId: o.sessionId,
          offerId: o.offer.offerId,
          expectedIntentRevision: o.intentRevision,
        },
      });
      if (activated.kind !== 'accepted') throw new Error('fixture offer activation refused');
      await scroll.applyEncounterAction(person.authority, {
        commandId: randomUUID(),
        kind: 'like',
        target: { assetId: starter.assetId, assetRevision: starter.revision },
        exposureId: activated.outcome.exposureId,
      });
      expect(
        await scroll.projectActivity({
          v: 1,
          universeId: person.universeId,
          privacyEpoch: 1,
          exposureId: activated.outcome.exposureId,
        }),
      ).toMatchObject({ kind: 'applied' });

      const saved = await useCases.applyAction(person.authority, {
        commandId: randomUUID(),
        kind: 'save',
        target: { assetId: asset.assetId, assetRevision: 1 },
      });
      if (saved.kind !== 'applied') throw new Error('fixture save refused');
      await applyEvidence({ v: 1, universeId: person.universeId, privacyEpoch: 1, actionId: saved.outcome.actionId });
      await withPersonalScope(person.authority, async (scope) => {
        const runId = randomUUID();
        await ledger.admitRun(scope, fixtureRunDescriptor(runId));
        await ledger.reserve(scope, fixtureReservation(randomUUID(), runId, 'a'));
      });
    };
    try {
      await seed(erased);
      await seed(kept);
      const before = {
        erased: await personalRowCounts(erased.universeId),
        kept: await personalRowCounts(kept.universeId),
      };
      expect(Object.values(before.erased).every((count) => count > 0)).toBe(true);
      const reports = await withPersonalScope(erased.authority, (scope) => eraseUniverse(scope, personalStores));
      expect(reports.kind === 'entered' && reports.value.every((report) => report.status === 'completed')).toBe(true);
      const after = {
        erased: await personalRowCounts(erased.universeId),
        kept: await personalRowCounts(kept.universeId),
      };
      expect(Object.values(after.erased).every((count) => count === 0)).toBe(true);
      expect(after.kept).toEqual(before.kept);
    } finally {
      await useCases.close();
      await scroll.close();
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
