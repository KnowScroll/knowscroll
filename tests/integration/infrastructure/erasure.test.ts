import { socialUseCases } from '@knowscroll/backend/modules/social/nest-providers';
import { accountAccessUseCases } from '@knowscroll/backend/modules/identity/nest-providers';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import { COVERAGE_POLICY, CONCEPT_CATALOGUE_VERSION, type CoverageCommand } from '@knowscroll/backend/modules/content';
import {
  makeAdmitCoverage,
  makeCoverageAdmissionPorts,
  coverageCatalogue,
} from '@knowscroll/backend/modules/content/nest-providers';
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
import { makeWithPersonalScope, transactionOf, type Database } from '@knowscroll/backend/infrastructure/postgres';
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
    const before = await database.db.selectFrom('social.pairs').selectAll().execute();
    expect(before.length).toBeGreaterThan(0);
    await withScope(a.authority, (scope) => eraseUniverse(scope, personalStores));
    expect(await database.db.selectFrom('social.pairs').selectAll().execute()).toEqual(before);
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
    // Exact synthetic semantic approval ONLY for this erasure fixture. The real reading pipeline
    // below must populate ALL new personal stores; production approval registry stays empty.
    const coverageSource = await database.db
      .selectFrom('content.asset_revisions')
      .select(['document_sha256', 'explanation_unit_id', 'reading_facts'])
      .where('asset_id', '=', starter.assetId)
      .where('revision', '=', starter.revision)
      .executeTakeFirstOrThrow();
    const coverageProvenance = await database.db
      .selectFrom('content.asset_provenance')
      .select('provenance')
      .where('asset_id', '=', starter.assetId)
      .where('revision', '=', starter.revision)
      .executeTakeFirstOrThrow();
    const coverageCommand: CoverageCommand = {
      version: 'content-coverage-command.v1',
      assetId: starter.assetId,
      assetRevision: starter.revision,
      expectedHeadRevision: 0,
      semanticReviewReference: 'ci-erasure-only-not-live-semantic-approval',
      change: {
        kind: 'admit',
        mapping: {
          version: COVERAGE_POLICY,
          documentSha256: coverageSource.document_sha256,
          provenanceSha256: canonicalSha256(coverageProvenance.provenance),
          explanationUnitId: coverageSource.explanation_unit_id,
          framing: 'factual',
          framingSha256: canonicalSha256({ kind: 'factual' }),
          readingFactsVersion: 2,
          readingFactsSha256: canonicalSha256(coverageSource.reading_facts),
          catalogueVersion: CONCEPT_CATALOGUE_VERSION,
          catalogueSha256: coverageCatalogue.sha256,
          bindings: [
            {
              topicId: 'earth.seasons',
              facetId: 'earth.seasons.axial-tilt',
              meaningSha256: coverageCatalogue.meaningSha256('earth.seasons', 'earth.seasons.axial-tilt')!,
              requiredBlockIds: ['intro-look-up'],
            },
          ],
        },
      },
    };
    await makeAdmitCoverage(
      makeCoverageAdmissionPorts(
        database.db,
        (digest, reference) =>
          digest === canonicalSha256(coverageCommand) && reference === coverageCommand.semanticReviewReference,
      ),
    )(coverageCommand);
    const applyEvidence = evidenceUseCase(database);
    const withPersonalScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
    const ledger = makeAttemptLedger(database.db);
    /** A person's reading of the starter Scroll: exposure, observations and a projected evidence revision. */
    const seedReading = async (person: FixturePerson) => {
      const exposure = await openActive(scroll, person, starter);
      await activatedAgo(database.db, exposure.exposureId, 30);
      const facts = await database.db
        .selectFrom('content.asset_revisions')
        .select('reading_facts')
        .where('asset_id', '=', starter.assetId)
        .where('revision', '=', starter.revision)
        .executeTakeFirstOrThrow();
      const blocks = (facts.reading_facts as { blocks: { id: string }[] }).blocks.map((b) => b.id);
      const ingested = await scroll.ingestObservations(person.authority, {
        instrumentationVersion: 1,
        events: [event(exposure, coverage(blocks, 4_000)), event(exposure, dwell([0, 68_000]))],
      });
      if (ingested.kind !== 'ingested' || ingested.accepted !== 2) throw new Error('fixture observations refused');
      const projected = await scroll.projectScrollReading({
        v: 1,
        universeId: person.universeId,
        privacyEpoch: 1,
        exposureId: exposure.exposureId,
      });
      if (projected.kind !== 'applied' || projected.qualification !== 'qualified')
        throw new Error('fixture qualified projection skipped');
      // Seed real qualified structural support, so the unchanged every-store>0 assertion covers PC too.
      expect(
        await scroll.projectActivity({
          v: 1,
          universeId: person.universeId,
          privacyEpoch: 1,
          exposureId: exposure.exposureId,
        }),
      ).toMatchObject({ kind: 'applied' });
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
      // Authored erasure-only private constraint on this already-activated discovery offer.
      // This exercises the new store without claiming actual Geography formation/navigation.
      const coverageHead = await database.db
        .selectFrom('content.coverage_revisions')
        .select(['revision', 'mapping_sha256'])
        .where('asset_id', '=', starter.assetId)
        .where('asset_revision', '=', starter.revision)
        .executeTakeFirstOrThrow();
      const regionConstraint = {
        version: 'offer-region-constraint.v1',
        region: {
          version: 'geography-region-constraint.v1',
          target: { kind: 'region', regionId: randomUUID(), expectedObjectRevision: 1, expectedGeographyRevision: 1 },
          planetId: randomUUID(),
          planetObjectRevision: 1,
          systemId: randomUUID(),
          topicId: 'earth.seasons',
          facetId: 'earth.seasons.axial-tilt',
          truthStatus: 'factual',
          catalogueVersion: 'content-concepts.v1',
        },
        coverage: {
          assetId: starter.assetId,
          assetRevision: starter.revision,
          headRevision: coverageHead.revision,
          mappingSha256: coverageHead.mapping_sha256,
        },
      };
      // The existing return fixture is intentionally nonregional. Author a separate exact
      // discovery descriptor in-place only in this owning CI fixture before adding its child.
      // No production offer is relabelled: the new child uses a fresh parent inserted below.
      const parent = await database.db
        .selectFrom('experience.offers')
        .selectAll()
        .where('id', '=', o.offer.offerId)
        .executeTakeFirstOrThrow();
      const regionalId = randomUUID();
      await database.db
        .insertInto('experience.offers')
        .values({
          ...parent,
          id: regionalId,
          mode: 'vertical',
          descriptor: { ...o.offer, offerId: regionalId, relation: { kind: 'discovery' } },
        })
        .execute();
      await database.db
        .insertInto('experience.offer_region_constraints')
        .values({
          universe_id: person.universeId,
          privacy_epoch: 1,
          offer_id: regionalId,
          asset_id: starter.assetId,
          asset_revision: starter.revision,
          coverage_head_revision: coverageHead.revision,
          mapping_sha256: coverageHead.mapping_sha256,
          constraint_payload: regionConstraint,
        })
        .execute();
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
      // Actual retained membership with a latest private place: every registered store remains covered.
      const membership = await database.db
        .selectFrom('experience.saved_items')
        .select('saved_entry_id')
        .where('universe_id', '=', person.universeId)
        .where('asset_id', '=', asset.assetId)
        .executeTakeFirstOrThrow();
      await database.db
        .insertInto('experience.saved_places')
        .values({
          universe_id: person.universeId,
          saved_entry_id: membership.saved_entry_id,
          place_revision: '2',
          position: JSON.stringify({ kind: 'reel', positionMs: 1234.5 }),
        })
        .execute();

      await applyEvidence({ v: 1, universeId: person.universeId, privacyEpoch: 1, actionId: saved.outcome.actionId });
      await withPersonalScope(person.authority, async (scope) => {
        const runId = randomUUID();
        await ledger.admitRun(scope, fixtureRunDescriptor(runId));
        await ledger.reserve(scope, fixtureReservation(randomUUID(), runId, 'a'));
        // Authored erasure-only fixture rows, never provider output or runtime planning evidence.
        const plannerRunId = randomUUID(),
          tx = transactionOf(scope);
        await tx
          .insertInto('supply.requests')
          .values({
            universe_id: person.universeId,
            privacy_epoch: 1,
            id: randomUUID(),
            command: { version: 'content-request.v1', fixture: 'Authored erasure-only private ask' },
            state: 'unavailable',
            request_revision: 1,
            revision: 1,
            decision: 'refuse',
            reason: 'unsupported_request',
            created_at: new Date(),
            updated_at: new Date(),
          })
          .execute();
        // Authored Scene erasure-only payloads: seed ALL new stores without claiming projection/formation.
        const sceneObjectId = randomUUID(),
          sceneChunkId = randomUUID(),
          sceneSystemId = randomUUID();
        const sceneFixture = { fixture: 'Authored CI erasure-only scene payload' };
        await tx
          .insertInto('scenes.manifests')
          .values({ universe_id: person.universeId, privacy_epoch: 1, scene_revision: 1, payload: sceneFixture })
          .execute();
        await tx
          .insertInto('scenes.chunks')
          .values({
            universe_id: person.universeId,
            privacy_epoch: 1,
            scene_revision: 1,
            chunk_id: sceneChunkId,
            system_id: sceneSystemId,
            payload: sceneFixture,
          })
          .execute();
        await tx
          .insertInto('scenes.objects')
          .values({
            universe_id: person.universeId,
            privacy_epoch: 1,
            object_id: sceneObjectId,
            system_id: sceneSystemId,
            chunk_id: sceneChunkId,
            slot: 0,
            payload: sceneFixture,
          })
          .execute();
        await tx
          .insertInto('scenes.state')
          .values({
            universe_id: person.universeId,
            privacy_epoch: 1,
            policy_version: 'canonical-lattice.v1',
            world_seed: 'a'.repeat(64),
            scene_revision: 1,
            payload: sceneFixture,
          })
          .execute();
        // Authored Geography erasure-only rows. No fixture object is installed in runtime.
        const geographyRunId = randomUUID(),
          geographyObjectId = randomUUID(),
          geographyTransitionId = randomUUID();
        await tx
          .insertInto('geography.runs')
          .values({
            universe_id: person.universeId,
            privacy_epoch: 1,
            id: geographyRunId,
            desired_revision: 1,
            status: 'accepted',
          })
          .execute();
        await tx
          .insertInto('geography.state')
          .values({
            universe_id: person.universeId,
            privacy_epoch: 1,
            revision: 1,
            structure_revision: 1,
            desired_revision: 1,
          })
          .execute();
        await tx
          .insertInto('geography.objects')
          .values({
            universe_id: person.universeId,
            privacy_epoch: 1,
            id: geographyObjectId,
            semantic_key: 'system:ci-erasure:factual',
            payload: { fixture: 'Authored erasure-only geography object' },
            support_refs: JSON.stringify([]),
          })
          .execute();
        await tx
          .insertInto('geography.relations')
          .values({
            universe_id: person.universeId,
            privacy_epoch: 1,
            id: randomUUID(),
            semantic_key: 'ci-erasure-route',
            kind: 'route',
            payload: { fixture: 'Authored erasure-only relation' },
            support_refs: JSON.stringify([]),
          })
          .execute();
        await tx
          .insertInto('geography.deltas')
          .values({
            universe_id: person.universeId,
            privacy_epoch: 1,
            revision: 1,
            transition_id: geographyTransitionId,
            run_id: geographyRunId,
            policy_version: 'geography-passive.v1',
            input_sha256: 'a'.repeat(64),
            payload: { fixture: 'Authored erasure-only delta' },
          })
          .execute();
        await tx
          .insertInto('planner.runs')
          .values({
            universe_id: person.universeId,
            privacy_epoch: 1,
            id: plannerRunId,
            revision: 1,
            status: 'accepted',
            context_version: 'planner-context.v0',
            context: { fixture: 'Authored erasure fixture; not a provider result' },
          })
          .execute();
        await tx
          .insertInto('planner.state')
          .values({ universe_id: person.universeId, privacy_epoch: 1, desired_revision: 1, accepted_revision: 1 })
          .execute();
        await tx
          .insertInto('planner.revisions')
          .values({
            universe_id: person.universeId,
            privacy_epoch: 1,
            revision: 1,
            run_id: plannerRunId,
            context_revision: 1,
            attempt_id: randomUUID(),
            policy_version: 'personal-planner.v0',
            // Explicit JSON text: pg otherwise encodes a JS array as a PostgreSQL array.
            opportunities: JSON.stringify([]),
          })
          .execute();
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

import { contentCutroomStores } from '@knowscroll/backend/modules/content/nest-providers';
import { reasoningCutroomStores } from '@knowscroll/backend/reasoning/nest-providers';
describe('closed Cutroom shared-public store inventory (real schema)', () => {
  let world: TestDatabase<Database>;
  beforeAll(async () => {
    world = await createTestDatabase<Database>('cutroom_inventory');
  });
  afterAll(async () => {
    await world.drop();
  });
  it('requires every actual Cutroom table and rejects any direct/transitive personal dependency', async () => {
    const declarations = [...contentCutroomStores, ...reasoningCutroomStores].map((x) => x.table).sort();
    const actual = (
      await sql<{
        name: string;
      }>`select n.nspname||'.'||c.relname name from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where c.relkind='r' and n.nspname in ('content','reasoning') and (c.relname like 'cutroom_%' or c.relname='reel_commissions') order by 1`.execute(
        world.db,
      )
    ).rows.map((x) => x.name);
    expect(actual).toEqual(declarations);
    expect(new Set(declarations).size).toBe(17);
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
