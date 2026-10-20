import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { eraseUniverse, checkErasureInventory } from '@knowscroll/backend/infrastructure/erasure';
import { personalStores } from '@knowscroll/backend/erasure-registry';
import {
  makeAdmitCoverage,
  makeCoverageAdmissionPorts,
  coverageCatalogue,
} from '@knowscroll/backend/modules/content/nest-providers';
import {
  COVERAGE_POLICY,
  CONCEPT_CATALOGUE_VERSION,
  type CoverageCommand,
  type CoverageMapping,
} from '@knowscroll/backend/modules/content';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { scrollUseCases, starterSource } from '../support/scroll.js';
import { activatedAgo, coverage, dwell, event, openActive } from '../support/observations.js';

/** Synthetic semantic approvals and authored sources ONLY; no live source/map/formation claim. */
describe('current observed personal coverage (PostgreSQL CI fixtures only)', () => {
  let database: TestDatabase<Database>, c: Awaited<ReturnType<typeof scrollUseCases>>;
  const approvals = new Map<string, string>();
  beforeAll(async () => {
    database = await createTestDatabase<Database>('personal_coverage');
    c = await scrollUseCases(database);
  });
  afterAll(async () => {
    await c.close();
    await database.drop();
  });
  const approved = (command: CoverageCommand) => {
    approvals.set(canonicalSha256(command), command.semanticReviewReference);
    return command;
  };
  const admit = () =>
    makeAdmitCoverage(makeCoverageAdmissionPorts(database.db, (digest, ref) => approvals.get(digest) === ref));
  const topic = 'earth.seasons',
    facet = 'earth.seasons.axial-tilt',
    otherFacet = 'earth.seasons.hemispheres';
  const job = (p: FixturePerson, id: string) => ({
    v: 1 as const,
    universeId: p.universeId,
    privacyEpoch: 1,
    exposureId: id,
  });
  async function fixture(unit = `ci-coverage-unit-${randomUUID()}`) {
    const source = starterSource() as {
      assetId: string;
      reference: string;
      publication: { explanationUnitId: string };
    };
    source.assetId = randomUUID();
    source.reference = 'ci-synthetic-map-not-live-semantics';
    source.publication.explanationUnitId = unit;
    const imported = await c.importScroll(source);
    if (imported.kind !== 'imported') throw new Error('fixture_import_refused');
    await database.db.deleteFrom('content.encounter_topics').where('asset_id', '=', source.assetId).execute();
    await database.db
      .insertInto('content.encounter_topics')
      .values([
        { asset_id: source.assetId, asset_revision: 1, topic_id: topic, role: 'primary', weight: 0.5 },
        { asset_id: source.assetId, asset_revision: 1, topic_id: 'earth.tides', role: 'supporting', weight: 0.5 },
      ])
      .execute();
    const row = await database.db
      .selectFrom('content.asset_revisions')
      .select(['document_sha256', 'reading_facts'])
      .where('asset_id', '=', source.assetId)
      .executeTakeFirstOrThrow();
    const provenance = await database.db
      .selectFrom('content.asset_provenance')
      .select('provenance')
      .where('asset_id', '=', source.assetId)
      .executeTakeFirstOrThrow();
    const facts = row.reading_facts as { blocks: { id: string }[] };
    const map: CoverageMapping = {
      version: COVERAGE_POLICY,
      documentSha256: row.document_sha256,
      provenanceSha256: canonicalSha256(provenance.provenance),
      explanationUnitId: unit,
      framing: 'factual',
      framingSha256: canonicalSha256({ kind: 'factual' }),
      readingFactsVersion: 2,
      readingFactsSha256: canonicalSha256(row.reading_facts),
      catalogueVersion: CONCEPT_CATALOGUE_VERSION,
      catalogueSha256: coverageCatalogue.sha256,
      bindings: [
        {
          topicId: topic,
          facetId: facet,
          meaningSha256: coverageCatalogue.meaningSha256(topic, facet)!,
          requiredBlockIds: ['intro-look-up', 'intro-short-version'],
        },
      ],
    };
    const command: CoverageCommand = {
      version: 'content-coverage-command.v1',
      assetId: source.assetId,
      assetRevision: 1,
      expectedHeadRevision: 0,
      semanticReviewReference: 'ci-fixture-review-only',
      change: { kind: 'admit', mapping: map },
    };
    await admit()(approved(command));
    return { assetId: source.assetId, revision: 1, unit, map, command, blocks: facts.blocks.map((b) => b.id) };
  }
  async function read(p: FixturePerson, f: Awaited<ReturnType<typeof fixture>>, omit: string[] = []) {
    const e = await openActive(c, p, f);
    await activatedAgo(database.db, e.exposureId, 20);
    await c.ingestObservations(p.authority, {
      instrumentationVersion: 1,
      events: [
        event(
          e,
          coverage(
            f.blocks.filter((id) => !omit.includes(id)),
            1000,
          ),
        ),
        event(e, dwell([0, 700000])),
      ],
    });
    expect(await c.projectScrollReading(job(p, e.exposureId))).toMatchObject({
      kind: 'applied',
      qualification: 'qualified',
    });
    expect(await c.projectActivity(job(p, e.exposureId))).toMatchObject({ kind: 'applied' });
    return e;
  }
  async function proof(p: FixturePerson, unit: string) {
    const r = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })(p.authority, (s) =>
      c.readTrustedCoverage(s, {
        probes: [
          { topicId: topic, facetId: facet, explanationUnitId: unit },
          { topicId: topic, facetId: otherFacet, explanationUnitId: unit },
          { topicId: 'earth.tides', facetId: facet, explanationUnitId: unit },
        ],
      }),
    );
    if (r.kind !== 'entered') throw new Error('fixture_scope_refused');
    return r.value;
  }
  async function activityRows(p: FixturePerson) {
    return database.db
      .selectFrom('evidence.activity_revisions')
      .select('id')
      .where('universe_id', '=', p.universeId)
      .orderBy('revision')
      .execute();
  }
  it('requires actual ALL-OF leaves despite qualification, and never crosses facets into other attributed topics', async () => {
    const p = await seedPerson(database.db),
      f = await fixture(),
      e = await read(p, f, ['intro-short-version']);
    expect((await proof(p, f.unit)).witnesses).toEqual([]);
    await c.ingestObservations(p.authority, {
      instrumentationVersion: 1,
      events: [event(e, coverage(['intro-short-version'], 1000))],
    });
    await c.projectScrollReading(job(p, e.exposureId));
    await c.projectActivity(job(p, e.exposureId));
    const result = await proof(p, f.unit);
    expect(result).toMatchObject({
      availability: 'available',
      completeness: 'not_asserted',
      supportedFormats: ['scroll'],
    });
    expect(result.witnesses).toHaveLength(1);
    expect(result.supports).toMatchObject([
      { topicId: topic, facetId: facet, explanationUnitId: f.unit, witnessExposureIds: [e.exposureId] },
    ]);
    expect(result.witnesses[0]).toMatchObject({
      topicId: topic,
      facetId: facet,
      explanationUnitId: f.unit,
      exposureId: e.exposureId,
    });
    expect(result.certificates[0]?.certificate).toMatchObject({
      universeId: p.universeId,
      privacyEpoch: 1,
      evidence: { revision: 2, inputWatermark: 3 },
      mapping: { documentSha256: f.map.documentSha256, provenanceSha256: f.map.provenanceSha256 },
      bindings: [{ requiredBlockIds: ['intro-look-up', 'intro-short-version'] }],
    });
    const legacy = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })(p.authority, (s) =>
      c.readExploration(s, {
        evaluatedAt: new Date().toISOString(),
        topicIds: [topic, 'earth.tides'],
        candidates: [{ explanationUnitId: f.unit, facets: [facet] }],
      }),
    );
    expect(legacy).toMatchObject({
      kind: 'entered',
      value: {
        coverageAvailability: 'unavailable',
        topics: [{ coveredFacets: 0 }, { coveredFacets: 0 }],
        supportingEvidence: [{ coveredFacets: [] }],
      },
    });
  });
  it('deduplicates variants and reconciles map-only A→B→A using the real current activity ID without an extra activity audit', async () => {
    const p = await seedPerson(database.db),
      a = await fixture(),
      b = await fixture(a.unit);
    const ea = await read(p, a),
      eb = await read(p, b);
    const before = await activityRows(p);
    const current = await database.db
      .selectFrom('evidence.activity_current')
      .select('activity_id')
      .where('universe_id', '=', p.universeId)
      .where('exposure_id', '=', ea.exposureId)
      .executeTakeFirstOrThrow();
    const counts = () =>
      database.db
        .selectFrom('personal_context.coverage_supports')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .execute();
    expect(await counts()).toMatchObject([{ reference_count: 2, explanation_unit_id: a.unit, facet_id: facet }]);
    const initial = await proof(p, a.unit);
    expect(initial.witnesses).toHaveLength(2);
    expect(initial.supports).toEqual([
      {
        topicId: topic,
        facetId: facet,
        meaningSha256: a.map.bindings[0]!.meaningSha256,
        explanationUnitId: a.unit,
        truthSha256: a.map.framingSha256,
        witnessExposureIds: [ea.exposureId, eb.exposureId].sort(),
      },
    ]);
    const mapB = {
      ...a.map,
      bindings: [
        {
          ...a.map.bindings[0]!,
          facetId: otherFacet,
          meaningSha256: coverageCatalogue.meaningSha256(topic, otherFacet)!,
        },
      ],
    };
    await admit()(approved({ ...a.command, expectedHeadRevision: 1, change: { kind: 'admit', mapping: mapB } }));
    expect((await proof(p, a.unit)).witnesses.map((w) => w.exposureId)).toEqual([eb.exposureId]);
    const reconciled = await c.reconcileActivity(p.authority, { limit: 100 });
    expect(reconciled.kind).toBe('entered');
    if (reconciled.kind === 'entered') expect(reconciled.value.queued + reconciled.value.pending).toBeGreaterThan(0);
    expect(await c.projectActivity(job(p, ea.exposureId))).toMatchObject({
      kind: 'applied',
      activityId: current.activity_id,
    });
    expect(await activityRows(p)).toEqual(before);
    expect(await counts()).toHaveLength(2);
    const mapped = await proof(p, a.unit);
    expect(mapped.witnesses.map((w) => w.facetId).sort()).toEqual([facet, otherFacet].sort());
    expect(mapped.supports.map((s) => s.facetId)).toEqual([facet, otherFacet].sort());
    expect(new Set(mapped.supports.map((s) => s.explanationUnitId))).toEqual(new Set([a.unit]));
    await admit()(approved({ ...a.command, expectedHeadRevision: 2 }));
    expect(await c.projectActivity(job(p, ea.exposureId))).toMatchObject({
      kind: 'applied',
      activityId: current.activity_id,
    });
    expect(await counts()).toMatchObject([{ reference_count: 2, facet_id: facet }]);
    expect((await proof(p, a.unit)).supports).toHaveLength(1);
    expect(await activityRows(p)).toEqual(before);
    const state = await database.db
      .selectFrom('identity.universes')
      .select('revision')
      .where('id', '=', p.universeId)
      .executeTakeFirstOrThrow();
    expect(await c.projectActivity(job(p, ea.exposureId))).toEqual({ kind: 'skipped', reason: 'already_applied' });
    expect(
      await database.db
        .selectFrom('identity.universes')
        .select('revision')
        .where('id', '=', p.universeId)
        .executeTakeFirstOrThrow(),
    ).toEqual(state);
    await admit()(approved({ ...a.command, expectedHeadRevision: 3, change: { kind: 'retract' } }));
    expect((await proof(p, a.unit)).supports).toMatchObject([{ witnessExposureIds: [eb.exposureId] }]);
    await admit()(approved({ ...b.command, expectedHeadRevision: 1, change: { kind: 'retract' } }));
    expect((await proof(p, a.unit)).supports).toEqual([]);
    await c.projectActivity(job(p, ea.exposureId));
    await c.projectActivity(job(p, eb.exposureId));
    expect(await counts()).toEqual([]);
  });
  it('immediately excludes retracted/withdrawn authority before projection, then removes the last incremental support', async () => {
    const p = await seedPerson(database.db),
      f = await fixture(),
      e = await read(p, f);
    await admit()(approved({ ...f.command, expectedHeadRevision: 1, change: { kind: 'retract' } }));
    expect((await proof(p, f.unit)).witnesses).toEqual([]);
    expect((await proof(p, f.unit)).supports).toEqual([]);
    expect(
      await database.db
        .selectFrom('personal_context.coverage_supports')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toHaveLength(1);
    await c.projectActivity(job(p, e.exposureId));
    expect(
      await database.db
        .selectFrom('personal_context.coverage_supports')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toEqual([]);
    await admit()(approved({ ...f.command, expectedHeadRevision: 2 }));
    await c.projectActivity(job(p, e.exposureId));
    await database.db.updateTable('content.assets').set({ status: 'withdrawn' }).where('id', '=', f.assetId).execute();
    expect((await proof(p, f.unit)).witnesses).toEqual([]);
    await c.projectActivity(job(p, e.exposureId));
    expect(
      await database.db
        .selectFrom('personal_context.coverage_references')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toEqual([]);
  });
  it('rechecks latest evidence so an explicit qualification correction invalidates retained witnesses and removes support', async () => {
    const p = await seedPerson(database.db),
      f = await fixture(),
      e = await read(p, f);
    // Explicit CI correction record, not an actual new observation or live read claim.
    await sql`insert into evidence.encounter_evidence(universe_id,id,exposure_id,revision,input_watermark,policy_version,qualification,q,coverage,active_dwell_ms,estimated_reading_ms,asset_id,asset_revision,summary,privacy_epoch)
   select universe_id,${randomUUID()}::uuid,exposure_id,revision+1,input_watermark,'ci-corrected-unqualified.v1','not_qualified',0,0,0,estimated_reading_ms,asset_id,asset_revision,summary,privacy_epoch from evidence.encounter_evidence where universe_id=${p.universeId}::uuid and exposure_id=${e.exposureId}::uuid order by revision desc limit 1`.execute(
      database.db,
    );
    expect((await proof(p, f.unit)).witnesses).toEqual([]);
    await c.projectActivity(job(p, e.exposureId));
    expect(
      await database.db
        .selectFrom('personal_context.coverage_supports')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toEqual([]);
  });
  it('holds current Content SHARE authority to the personal commit and refuses old proofs after a waiting correction', async () => {
    const p = await seedPerson(database.db),
      f = await fixture();
    await read(p, f);
    let ready!: () => void, release!: () => void;
    const entered = new Promise<void>((r) => {
      ready = r;
    });
    const held = new Promise<void>((r) => {
      release = r;
    });
    const consumer = makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })(p.authority, async (s) => {
      const result = await c.readTrustedCoverage(s, {
        probes: [{ topicId: topic, facetId: facet, explanationUnitId: f.unit }],
      });
      expect(result.witnesses).toHaveLength(1);
      ready();
      await held;
    });
    await entered;
    const correction = admit()(approved({ ...f.command, expectedHeadRevision: 1, change: { kind: 'retract' } }));
    try {
      await expect
        .poll(async () => {
          const r = await sql<{
            count: number;
          }>`select count(*)::int as count from pg_stat_activity where datname=current_database() and wait_event_type='Lock'`.execute(
            database.db,
          );
          return r.rows[0]?.count ?? 0;
        })
        .toBeGreaterThan(0);
    } finally {
      release();
    }
    await consumer;
    await correction;
    expect((await proof(p, f.unit)).witnesses).toEqual([]);
  });
  it('refuses an overflowing indexed reference probe without returning truncated witnesses', async () => {
    const p = await seedPerson(database.db),
      f = await fixture(),
      e = await read(p, f);
    const actual = await database.db
      .selectFrom('evidence.activity_current')
      .select('activity_id')
      .where('universe_id', '=', p.universeId)
      .where('exposure_id', '=', e.exposureId)
      .executeTakeFirstOrThrow();
    // Deliberate prepared-row overflow fixture. Cloned payloads are NOT valid observed certificates;
    // the limit must refuse BEFORE validating or returning any such row as a witness.
    await sql`with seed as materialized (select gen_random_uuid() exposure,gen_random_uuid() activity from generate_series(1,1001)),
      exposures as (insert into experience.exposures select (jsonb_populate_record(null::experience.exposures,to_jsonb(base)||jsonb_build_object('id',seed.exposure,'command_id',gen_random_uuid()))).* from experience.exposures base cross join seed where base.universe_id=${p.universeId}::uuid and base.id=${e.exposureId}::uuid returning id),
      activities as (insert into evidence.activity_revisions select (jsonb_populate_record(null::evidence.activity_revisions,to_jsonb(base)||jsonb_build_object('id',seed.activity,'exposure_id',seed.exposure))).* from evidence.activity_revisions base cross join seed join exposures on exposures.id=seed.exposure where base.universe_id=${p.universeId}::uuid and base.id=${actual.activity_id}::uuid returning exposure_id,id),
      certificates as (insert into personal_context.coverage_contributions(universe_id,privacy_epoch,exposure_id,activity_id,input_sha256,payload) select base.universe_id,base.privacy_epoch,activities.exposure_id,activities.id,base.input_sha256,base.payload from personal_context.coverage_contributions base cross join activities where base.universe_id=${p.universeId}::uuid and base.exposure_id=${e.exposureId}::uuid returning exposure_id)
      insert into personal_context.coverage_references(universe_id,privacy_epoch,exposure_id,topic_id,facet_id,meaning_sha256,explanation_unit_id,truth_sha256) select base.universe_id,base.privacy_epoch,certificates.exposure_id,base.topic_id,base.facet_id,base.meaning_sha256,base.explanation_unit_id,base.truth_sha256 from personal_context.coverage_references base cross join certificates where base.universe_id=${p.universeId}::uuid and base.exposure_id=${e.exposureId}::uuid`.execute(
      database.db,
    );
    expect(await proof(p, f.unit)).toEqual({
      version: 'trusted-coverage-read.v1',
      availability: 'unavailable',
      reason: 'limit',
      completeness: 'not_asserted',
      supportedFormats: ['scroll'],
      supports: [],
      witnesses: [],
      certificates: [],
    });
  });
  it('rolls back the combined projection, bounds proof queries, erases all stores, and fences late reset work', async () => {
    const p = await seedPerson(database.db),
      f = await fixture(),
      e = await read(p, f);
    await admit()(approved({ ...f.command, expectedHeadRevision: 1, change: { kind: 'retract' } }));
    const before = await database.db
      .selectFrom('personal_context.coverage_contributions')
      .selectAll()
      .where('universe_id', '=', p.universeId)
      .execute();
    const failing = await scrollUseCases(database, {
      wrapScope: (scope) => (authority, work) =>
        scope(authority, async (s) => {
          const result = await work(s);
          if (authority.actor.kind === 'system' && authority.actor.purpose === 'evidence.project-encounter-activity')
            throw new Error('CI_COMBINED_COVERAGE_ROLLBACK');
          return result;
        }),
    });
    try {
      await expect(failing.projectActivity(job(p, e.exposureId))).rejects.toThrow('CI_COMBINED_COVERAGE_ROLLBACK');
    } finally {
      await failing.close();
    }
    expect(
      await database.db
        .selectFrom('personal_context.coverage_contributions')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toEqual(before);
    await expect(
      makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })(p.authority, (s) =>
        c.readTrustedCoverage(s, {
          probes: Array.from({ length: 101 }, (_, i) => ({
            topicId: topic,
            facetId: facet,
            explanationUnitId: String(i),
          })),
        }),
      ),
    ).rejects.toThrow();
    expect(await checkErasureInventory(database.db, personalStores)).toEqual([]);
    await makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })(p.authority, (s) =>
      eraseUniverse(s, personalStores),
    );
    await database.db
      .updateTable('identity.universes')
      .set({ privacy_epoch: 2 })
      .where('id', '=', p.universeId)
      .execute();
    expect(await c.projectActivity(job(p, e.exposureId))).toEqual({ kind: 'skipped', reason: 'epoch_changed' });
    for (const table of ['coverage_references', 'coverage_supports', 'coverage_contributions'] as const)
      expect(
        await database.db
          .selectFrom(`personal_context.${table}`)
          .selectAll()
          .where('universe_id', '=', p.universeId)
          .execute(),
      ).toEqual([]);
  });
});
