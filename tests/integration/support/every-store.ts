import { canonicalSha256 } from '@knowscroll/scroll-model';
import { CONTEXT_POLICY, RecordingContributionEnvelopeSchema } from '@knowscroll/backend/modules/personal-context';
import { requestHash } from '@knowscroll/backend/infrastructure/receipts';
import { COVERAGE_POLICY, CONCEPT_CATALOGUE_VERSION, type CoverageCommand } from '@knowscroll/backend/modules/content';
import {
  makeAdmitCoverage,
  makeCoverageAdmissionPorts,
  coverageCatalogue,
} from '@knowscroll/backend/modules/content/nest-providers';
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { expect } from 'vitest';
import { composeEncounter } from '@knowscroll/backend/modules/composer';
import { makeComposerStore } from '@knowscroll/backend/modules/composer/nest-providers';
import { fixtureComposerSnapshot, seedComposerBuffer } from '../support/composer.js';
import { makeWithPersonalScope, transactionOf, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { makeAttemptLedger } from '@knowscroll/backend/reasoning/nest-providers';
import { type TestDatabase } from '../support/database.js';
import { evidenceUseCase } from '../support/evidence.js';
import { experienceUseCases } from '../support/experience.js';
import { seedAsset, type FixturePerson } from '../support/fixtures.js';
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

/**
 * Seeds every universe-keyed store of a person through the real use cases and authored erasure
 * fixtures (never provider output): the shared fixture of the erasure and account-deletion tests.
 * `close` releases the use cases' resources.
 */
export async function everyStoreSeeder(
  database: TestDatabase<Database>,
): Promise<{ readonly seed: (person: FixturePerson) => Promise<void>; readonly close: () => Promise<void> }> {
  const asset = await seedAsset(database.db);
  const useCases = await experienceUseCases(database, { recording: true });
  const scroll = await scrollUseCases(database, { recording: true });
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
    // Erasure-only coexistence fixture: retain exact valid legacy-shaped copies of the
    // freshly committed PC source. Production performs no history initialization/copy.
    // Both generations of stores must be populated; the every-store>0 assertion stays exact.
    const effective = await database.db
      .selectFrom('personal_context.recording_exposure_contributions')
      .selectAll()
      .where('universe_id', '=', person.universeId)
      .where('exposure_id', '=', exposure.exposureId)
      .executeTakeFirstOrThrow();
    const contribution = RecordingContributionEnvelopeSchema.parse(effective.payload).contribution;
    if (!contribution?.qualified) throw new Error('fixture_pc_recording_support_missing');
    await database.db
      .insertInto('personal_context.contributions')
      .values({
        universe_id: person.universeId,
        privacy_epoch: 1,
        exposure_id: exposure.exposureId,
        explanation_unit_id: contribution.explanationUnitId,
        qualified: true,
        input_sha256: requestHash(CONTEXT_POLICY, contribution),
        payload_version: contribution.version,
        payload: contribution,
      })
      .execute();
    const source = await database.db
      .selectFrom('personal_context.recording_segment_heads')
      .selectAll()
      .where('universe_id', '=', person.universeId)
      .where('exposure_id', '=', exposure.exposureId)
      .where('recording_generation', '=', 1)
      .executeTakeFirstOrThrow();
    if (!source.coverage || !source.coverage_sha256) throw new Error('fixture_pc_recording_certificate_missing');
    await database.db
      .insertInto('personal_context.coverage_contributions')
      .values({
        universe_id: person.universeId,
        privacy_epoch: 1,
        exposure_id: exposure.exposureId,
        activity_id: source.activity_id,
        input_sha256: canonicalSha256({ activityId: source.activity_id, certificate: source.coverage }),
        payload: source.coverage,
      })
      .execute();
    await sql`insert into personal_context.coverage_references(universe_id,privacy_epoch,exposure_id,topic_id,facet_id,meaning_sha256,explanation_unit_id,truth_sha256)
        select universe_id,privacy_epoch,exposure_id,topic_id,facet_id,meaning_sha256,explanation_unit_id,truth_sha256
        from personal_context.recording_coverage_references where universe_id=${person.universeId}::uuid and exposure_id=${exposure.exposureId}::uuid`.execute(
      database.db,
    );
  };
  const seed = async (person: FixturePerson) => {
    await withPersonalScope(person.authority, (scope) =>
      makeComposerStore({ isOperator: () => true }).persistComposerDecision(
        scope,
        { decisionId: randomUUID(), commandId: randomUUID() },
        composeEncounter(fixtureComposerSnapshot(person.authority)),
      ),
    );
    await seedComposerBuffer(withPersonalScope, person.authority);
    await seedReading(person);
    const opened = await scroll.navigate(person.authority, {
      commandId: randomUUID(),
      target: { kind: 'return', assetId: starter.assetId, assetRevision: starter.revision },
      capabilities: {
        documentSchemas: ['scroll-document.v1'],
        blocks: { fallback: [1], paragraph: [1], subheading: [1] },
      },
    });
    if (opened.kind !== 'accepted' || opened.outcome.status !== 'ready') throw new Error('fixture navigation refused');
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
    ).toMatchObject({ kind: 'skipped', reason: 'already_applied' });

    // Erasure-only historical coexistence rows copied from actual accepted descriptors.
    // Modern writers never read these as channel certificates or inherit their raw history.
    await sql`insert into experience.encounter_lineage(universe_id,privacy_epoch,exposure_id,asset_id,asset_revision,kind,explanation_unit_id,facets,activated_at)
        select universe_id,privacy_epoch,exposure_id,asset_id,asset_revision,kind,explanation_unit_id,
          array(select jsonb_array_elements_text(attribution_payload->'facets')),first_eligible_activation_at
        from experience.recording_segments where universe_id=${person.universeId}::uuid and recording_generation=1
        on conflict do nothing`.execute(database.db);
    await sql`insert into experience.encounter_activity_inputs(universe_id,privacy_epoch,exposure_id,liked,saved,horizontal,returned,action_revision,navigation_revision)
        select universe_id,privacy_epoch,exposure_id,coalesce(liked_override,false),coalesce(saved_override,false),horizontal,returned,action_revision,navigation_revision
        from experience.recording_segment_inputs where universe_id=${person.universeId}::uuid and recording_generation=1
        on conflict do nothing`.execute(database.db);
    await sql`insert into experience.navigation_transitions(universe_id,privacy_epoch,target_exposure_id,offer_id,session_id,mode,horizontal,returned,policy_version)
        values(${person.universeId}::uuid,1,${activated.outcome.exposureId}::uuid,${o.offer.offerId}::uuid,${o.sessionId}::uuid,'return',false,false,'activity.v0')`.execute(
      database.db,
    );

    const saved = await useCases.applyAction(person.authority, {
      commandId: randomUUID(),
      kind: 'save',
      target: { assetId: asset.assetId, assetRevision: 1 },
    });
    if (saved.kind !== 'applied') throw new Error('fixture save refused');
    // A short-lived "Not interested" on the same asset: the routing constraint is a personal store too.
    const notInterested = await scroll.notInterested.set(person.authority, {
      commandId: randomUUID(),
      assetId: asset.assetId,
    });
    if (notInterested.kind !== 'applied') throw new Error('fixture not-interested refused');
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
        // Real qualified effects already create this state; retain it unchanged.
        .onConflict((conflict) => conflict.columns(['universe_id', 'privacy_epoch']).doNothing())
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
      // Authored erasure-only actual creation tuple: populate the new registered delivery
      // store, not a live formation, semantic approval or shown assertion.
      const formationRecordedAt = new Date().toISOString();
      const formationGeography = { revision: 1, structureRevision: 1, activityRevision: 0 };
      const formationTarget = {
        objectId: geographyObjectId,
        parentId: person.universeId,
        kind: 'system' as const,
        objectRevision: 1,
        label: 'Authored erasure-only system',
        truthStatus: 'factual' as const,
      };
      const formationFact = {
        transitionId: geographyTransitionId,
        recordedAt: formationRecordedAt,
        geography: formationGeography,
        targets: [formationTarget],
        sequence: { kind: 'final_still' },
      };
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
          payload: {
            fixture: 'Authored erasure-only delta',
            recordedAt: formationRecordedAt,
            geography: formationGeography,
            operations: [
              {
                kind: 'create_system',
                object: {
                  id: geographyObjectId,
                  parent: { id: person.universeId },
                  kind: 'system',
                  objectRevision: 1,
                  label: formationTarget.label,
                  truthStatus: 'factual',
                },
              },
            ],
          },
        })
        .execute();
      await tx
        .insertInto('scenes.formation_presentations')
        .values({
          universe_id: person.universeId,
          privacy_epoch: 1,
          transition_id: geographyTransitionId,
          recorded_at: new Date(formationRecordedAt),
          geography_revision: 1,
          structure_revision: 1,
          activity_revision: 0,
          target_count: 1,
          fact: JSON.stringify(formationFact),
          limited: false,
        })
        .execute();
      // Authored erasure-only copy of what visitors may be shown: no sharing choice, no real planet.
      const visitSystemId = randomUUID();
      await tx
        .insertInto('social.visit_publications')
        .values({
          universe_id: person.universeId,
          projection_token: 1,
          geography_revision: 1,
          refreshed_at: new Date(),
        })
        .execute();
      await tx
        .insertInto('social.visit_systems')
        .values({
          universe_id: person.universeId,
          system_id: visitSystemId,
          public_system_id: randomUUID(),
          label: 'Authored erasure-only shared system',
        })
        .execute();
      await tx
        .insertInto('social.visit_planets')
        .values({
          universe_id: person.universeId,
          planet_id: randomUUID(),
          system_id: visitSystemId,
          public_planet_id: randomUUID(),
          label: 'Authored erasure-only shared planet',
        })
        .execute();
      // Authored erasure-only play record: a locked call and its tally, not a claim that anyone played a Scroll.
      await tx
        .insertInto('play.calls')
        .values({
          universe_id: person.universeId,
          privacy_epoch: 1,
          asset_id: starter.assetId,
          revision: starter.revision,
          stop_id: 'ci-erasure-call',
          option: 0,
          correct: false,
          command_id: randomUUID(),
        })
        .execute();
      await tx
        .insertInto('play.scroll_results')
        .values({
          universe_id: person.universeId,
          privacy_epoch: 1,
          asset_id: starter.assetId,
          revision: starter.revision,
          calls_locked: 1,
          sparks: 0,
          combo: 0,
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
        // Do not replace the genuine pending state with the authored erasure-only row.
        .onConflict((conflict) => conflict.columns(['universe_id', 'privacy_epoch']).doNothing())
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
  return {
    seed,
    close: async () => {
      await useCases.close();
      await scroll.close();
    },
  };
}
