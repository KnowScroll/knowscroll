import { AsyncResource } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import {
  makeWithPersonalScope,
  fencePersonalRecording,
  recordingTransactionOf,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import { accountAccessUseCases, recordingPolicyFor } from '@knowscroll/backend/modules/identity/nest-providers';
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
import { READ_COVERAGE_INPUTS, type ReadCoverageInputs } from '@knowscroll/backend/modules/personal-context';
import { personalContextProviders } from '@knowscroll/backend/modules/personal-context/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { buildFromProviders } from '../support/providers.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { scrollUseCases, starterSource } from '../support/scroll.js';
import { activatedAgo, coverage, dwell, event, openActive } from '../support/observations.js';
import { recordingPerson } from '../support/recording-person.js';
import { signal } from '../support/fixture-model.js';
import { geographyWorld, type GeographyWorld } from '../support/geography-world.js';
import { seedOlderRereads } from '../support/rereads.js';

/**
 * The head `content readmit-coverage` appends after the concept plan grew (#674): the same mapping under
 * another catalogue digest, admitted through the normal reviewed path with that digest as the plan's.
 */
/**
 * Runs `work` in the async context of module load, outside any marked transaction, as a concurrent
 * admission on another connection would run. Content takes no lock in the personal transaction before
 * the coverage fence, so this cannot wait on it.
 */
const outsideTransaction = AsyncResource.bind(<T>(work: () => Promise<T>): Promise<T> => work());

async function appendDigestOnlyHead(
  db: TestDatabase<Database>['db'],
  f: { readonly command: CoverageCommand; readonly map: CoverageMapping },
  expectedHeadRevision: number,
) {
  const grown = {
    ...coverageCatalogue,
    sha256: canonicalSha256({ fixturePlan: 'ci-grown-concept-plan', expectedHeadRevision }),
  };
  const command: CoverageCommand = {
    ...f.command,
    expectedHeadRevision,
    semanticReviewReference: 'ci-digest-only-fixture-review',
    change: { kind: 'admit', mapping: { ...f.map, catalogueSha256: grown.sha256 } },
  };
  const reviewed = (digest: string, reference: string) =>
    digest === canonicalSha256(command) && reference === command.semanticReviewReference;
  return makeAdmitCoverage({ ...makeCoverageAdmissionPorts(db, reviewed), catalogue: grown })(command);
}

/** Synthetic semantic approvals and authored sources ONLY; no live source/map/formation claim. */
describe('current observed personal coverage (PostgreSQL CI fixtures only)', () => {
  let database: TestDatabase<Database>, c: Awaited<ReturnType<typeof scrollUseCases>>;
  const approvals = new Map<string, string>();
  beforeAll(async () => {
    database = await createTestDatabase<Database>('personal_coverage');
    c = await scrollUseCases(database, { recording: true });
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
  const readInputs = buildFromProviders(
    personalContextProviders(),
    READ_COVERAGE_INPUTS,
    new Map(),
  ) as ReadCoverageInputs;
  async function discovery(p: FixturePerson) {
    const result = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })(p.authority, readInputs);
    if (result.kind !== 'entered') throw new Error('fixture_scope_refused');
    return result.value;
  }
  async function seedDiscoveryReferences(legacyCount: number, recordingCount: number) {
    const p = await seedPerson(database.db),
      f = await fixture(),
      e = await openActive(c, p, f);
    await activatedAgo(database.db, e.exposureId, 20);
    expect(
      await c.ingestObservations(p.authority, {
        instrumentationVersion: 1,
        events: [event(e, coverage(f.blocks, 1000)), event(e, dwell([0, 700000]))],
      }),
    ).toMatchObject({ kind: 'ingested', accepted: 2 });
    const q = await c.projectScrollReading(job(p, e.exposureId));
    expect(q).toMatchObject({ kind: 'applied', qualification: 'qualified' });
    if (q.kind !== 'applied') throw new Error('fixture_qualification_refused');
    // Synthetic PREPARED INDEX rows only, not a successful recording pipeline/certificate.
    // Discovery must not hydrate these deliberately incomplete certificate bodies. Each duplicate
    // has its own exposure/audits and passes actual FKs/guards; no trigger or effect is disabled.
    await database.db.transaction().execute(async (tx) => {
      const seed = await sql<{ exposure: string; activity: string; qualification: string; recording: boolean }>`
        select gen_random_uuid() exposure,gen_random_uuid() activity,gen_random_uuid() qualification,
          n>${legacyCount} recording from generate_series(1,${legacyCount + recordingCount}) n`.execute(tx);
      const source = sql`(select * from jsonb_to_recordset(${JSON.stringify(seed.rows)}::jsonb)
        as s(exposure uuid,activity uuid,qualification uuid,recording boolean))`;
      await sql`with seed as ${source} insert into experience.exposures
        select (jsonb_populate_record(null::experience.exposures,to_jsonb(base)||
          jsonb_build_object('id',seed.exposure,'command_id',gen_random_uuid()))).*
        from experience.exposures base cross join seed where base.universe_id=${p.universeId}::uuid and base.id=${e.exposureId}::uuid`.execute(
        tx,
      );
      await sql`with seed as ${source} insert into evidence.encounter_evidence
        select (jsonb_populate_record(null::evidence.encounter_evidence,to_jsonb(base)||
          jsonb_build_object('id',seed.qualification,'exposure_id',seed.exposure))).*
        from evidence.encounter_evidence base cross join seed where base.universe_id=${p.universeId}::uuid and base.id=${q.evidenceId}::uuid`.execute(
        tx,
      );
      await sql`with seed as ${source} insert into evidence.activity_revisions(universe_id,privacy_epoch,id,exposure_id,revision,input_sha256,input_vector,channels,activity,policy_version)
        select ${p.universeId}::uuid,1,activity,exposure,1,repeat('0',64),'{}'::jsonb,'{}'::jsonb,0,'activity.v0' from seed`.execute(
        tx,
      );
      await sql`with seed as ${source} insert into personal_context.coverage_contributions(universe_id,privacy_epoch,exposure_id,activity_id,input_sha256,payload)
        select ${p.universeId}::uuid,1,exposure,activity,repeat('0',64),
          jsonb_build_object('version','observed-static-coverage.v1','evidence',jsonb_build_object('id',qualification::text)) from seed`.execute(
        tx,
      );
      await sql`with seed as ${source} insert into experience.recording_segments(universe_id,privacy_epoch,exposure_id,recording_generation,asset_id,asset_revision,kind,explanation_unit_id,attribution_sha256,attribution_payload,initialized_at)
        select ${p.universeId}::uuid,1,exposure,1,${f.assetId}::uuid,1,'scroll',${f.unit},repeat('0',64),'{"topics":[],"facets":[]}'::jsonb,now() from seed where recording`.execute(
        tx,
      );
      await sql`with seed as ${source} insert into personal_context.recording_coverage_contributions(universe_id,privacy_epoch,exposure_id,working_generation,input_sha256,witnesses)
        select ${p.universeId}::uuid,1,exposure,1,repeat('0',64),'[]'::jsonb from seed where recording`.execute(tx);
      await sql`with seed as ${source} insert into personal_context.recording_coverage_references(universe_id,privacy_epoch,exposure_id,topic_id,facet_id,meaning_sha256,explanation_unit_id,truth_sha256,source_kind,source_generation,source_activity_id,source_qualification_id,source_certificate_sha256,source_legacy_exposure_id)
        select ${p.universeId}::uuid,1,exposure,${topic},${facet},repeat('0',64),${f.unit},repeat('0',64),'legacy',1,activity,qualification,repeat('0',64),exposure from seed where recording`.execute(
        tx,
      );
      await sql`with seed as ${source} insert into personal_context.coverage_references(universe_id,privacy_epoch,exposure_id,topic_id,facet_id,meaning_sha256,explanation_unit_id,truth_sha256)
        select ${p.universeId}::uuid,1,exposure,${topic},${facet},repeat('0',64),${f.unit},repeat('0',64) from seed where not recording`.execute(
        tx,
      );
      // Discovery reads the distinct support keys the projection keeps beside the references.
      await sql`insert into personal_context.coverage_supports(universe_id,privacy_epoch,topic_id,facet_id,meaning_sha256,explanation_unit_id,truth_sha256,reference_count)
        values(${p.universeId}::uuid,1,${topic},${facet},repeat('0',64),${f.unit},repeat('0',64),${legacyCount + recordingCount})`.execute(
        tx,
      );
    });
    return { p, f };
  }
  /** `count` distinct support keys, one reference each; no certificate stands behind them. */
  async function seedDistinctSupports(count: number) {
    const p = await seedPerson(database.db);
    await sql`insert into personal_context.coverage_supports(universe_id,privacy_epoch,topic_id,facet_id,meaning_sha256,explanation_unit_id,truth_sha256,reference_count)
      select ${p.universeId}::uuid,1,${topic},${facet},repeat('0',64),'ci-distinct-unit-'||n,repeat('0',64),1 from generate_series(1,${count}) n`.execute(
      database.db,
    );
    return p;
  }
  it.each([
    { legacy: 1001, recording: 0 },
    { legacy: 0, recording: 1001 },
    { legacy: 600, recording: 401 },
  ])(
    'discovers a reader whose raw references exceed 1000 by their distinct keys: $legacy legacy/$recording recording (#674)',
    async ({ legacy, recording }) => {
      const { p, f } = await seedDiscoveryReferences(legacy, recording);
      expect(await discovery(p)).toEqual({
        revision: 0,
        completeness: 'not_asserted',
        availability: 'available',
        reason: 'bounded',
        probes: [{ topicId: topic, facetId: facet, explanationUnitId: f.unit }],
      });
    },
  );
  it('discovers each distinct key once, however many references hold it', async () => {
    const { p, f } = await seedDiscoveryReferences(2, 2);
    expect(await discovery(p)).toEqual({
      revision: 0,
      completeness: 'not_asserted',
      availability: 'available',
      reason: 'bounded',
      probes: [{ topicId: topic, facetId: facet, explanationUnitId: f.unit }],
    });
  });
  it('discovers a reader with no support yet as no keys, not as a limit', async () => {
    const p = await seedPerson(database.db);
    expect(await discovery(p)).toEqual({
      revision: 0,
      completeness: 'not_asserted',
      availability: 'available',
      reason: 'bounded',
      probes: [],
    });
  });
  it('returns 1000 distinct keys, and refuses the 1001st instead of truncating', async () => {
    const full = await discovery(await seedDistinctSupports(1000));
    expect(full).toMatchObject({ availability: 'available', reason: 'bounded' });
    expect(full.probes).toHaveLength(1000);
    expect(await discovery(await seedDistinctSupports(1001))).toEqual({
      revision: 0,
      completeness: 'not_asserted',
      availability: 'unavailable',
      reason: 'limit',
      probes: [],
    });
  });
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
      .selectFrom('evidence.recording_segment_heads')
      .where('recording_generation', '=', 1)
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
    // Two exposures prove one key; the read returns the newest (#674). Both still count in the projection.
    expect(initial.witnesses).toHaveLength(1);
    expect(initial.witnesses[0]).toMatchObject({ exposureId: eb.exposureId });
    for (const w of initial.witnesses) {
      expect(w).toMatchObject({ sourceKind: 'segment', recordingGeneration: 1 });
      expect(
        initial.certificates.some(
          (c) =>
            c.witnessKey === w.witnessKey &&
            c.activityId === w.activityId &&
            c.qualificationId === w.qualificationId &&
            c.certificateSha256 === w.certificateSha256,
        ),
      ).toBe(true);
    }
    expect(initial.supports).toEqual([
      {
        topicId: topic,
        facetId: facet,
        meaningSha256: a.map.bindings[0]!.meaningSha256,
        explanationUnitId: a.unit,
        truthSha256: a.map.framingSha256,
        witnessExposureIds: [eb.exposureId],
      },
    ]);
    const originalA = await database.db
      .selectFrom('personal_context.recording_coverage_references')
      .select(['source_activity_id', 'source_qualification_id', 'source_certificate_sha256'])
      .where('universe_id', '=', p.universeId)
      .where('exposure_id', '=', ea.exposureId)
      .executeTakeFirstOrThrow();
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
    // The map correction moved ea to another facet, so ea is now the witness of that key, on the
    // same activity and qualification and under a new certificate.
    const replacement = mapped.witnesses.find((w) => w.exposureId === ea.exposureId)!;
    expect(replacement).toMatchObject({
      facetId: otherFacet,
      activityId: originalA.source_activity_id,
      qualificationId: originalA.source_qualification_id,
    });
    expect(replacement.certificateSha256).not.toBe(originalA.source_certificate_sha256);
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
    const p = await recordingPerson(database),
      f = await fixture(),
      e = await read(p, f);
    const original = (await proof(p, f.unit)).witnesses;
    expect(original).toHaveLength(1);
    // An unrelated newer global audit is NOT a descriptor-owned correction. Never restore
    // exposure-wide latest-row invalidation over exact retained segment identities.
    await sql`insert into evidence.encounter_evidence(universe_id,id,exposure_id,revision,input_watermark,policy_version,qualification,q,coverage,active_dwell_ms,estimated_reading_ms,asset_id,asset_revision,summary,privacy_epoch)
      select universe_id,${randomUUID()}::uuid,exposure_id,revision+1,input_watermark,'ci-unselected-unqualified.v1','not_qualified',0,0,0,estimated_reading_ms,asset_id,asset_revision,summary,privacy_epoch from evidence.encounter_evidence where universe_id=${p.universeId}::uuid and id=${original[0]!.qualificationId}::uuid`.execute(
      database.db,
    );
    expect((await proof(p, f.unit)).witnesses).toEqual(original);
    // Actual current original input lineage exists before this EXPLICIT CI correction record.
    // This is not a new operator API, sensor result or permission to rewrite a historical head.
    expect(
      await c.ingestObservations(p.authority, {
        instrumentationVersion: 1,
        events: [event(e, dwell([700000, 700001]))],
      }),
    ).toMatchObject({ kind: 'ingested', accepted: 1 });
    const corrected = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })(p.authority, async (scope) => {
      if (
        (await accountAccessUseCases({ db: database.db, lockTimeoutMs: 5000 }).fenceOwnAccount(scope)).kind !== 'active'
      )
        throw new Error('CI_CORRECTION_OWN');
      const gate = await fencePersonalRecording(scope, original[0]!.recordingGeneration);
      if (gate.kind !== 'recording') throw new Error('CI_CORRECTION_GENERATION');
      const db = recordingTransactionOf(gate.scope),
        id = randomUUID();
      const source = await db
        .selectFrom('evidence.encounter_evidence')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .where('id', '=', original[0]!.qualificationId)
        .executeTakeFirstOrThrow();
      const head = await db
        .selectFrom('evidence.recording_segment_heads')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .where('privacy_epoch', '=', 1)
        .where('exposure_id', '=', e.exposureId)
        .where('recording_generation', '=', gate.scope.generation)
        .executeTakeFirstOrThrow();
      expect(source.policy_version).toBe('scroll-qualification.v0');
      expect((head.source_vector as { legacyQualificationId: string }).legacyQualificationId).toBe(source.id);
      const actual = await db
        .selectFrom('evidence.observations')
        .select('seq')
        .where('universe_id', '=', p.universeId)
        .where('privacy_epoch', '=', 1)
        .where('exposure_id', '=', e.exposureId)
        .where('recording_generation', '=', gate.scope.generation)
        .orderBy('seq', 'desc')
        .executeTakeFirstOrThrow();
      expect(actual.seq).toBeGreaterThan(source.input_watermark);
      await sql`insert into evidence.encounter_evidence(universe_id,id,exposure_id,revision,input_watermark,policy_version,qualification,q,coverage,active_dwell_ms,estimated_reading_ms,asset_id,asset_revision,summary,privacy_epoch,recording_generation)
        select universe_id,${id}::uuid,exposure_id,(select max(revision)+1 from evidence.encounter_evidence where universe_id=${p.universeId}::uuid and exposure_id=${e.exposureId}::uuid),${actual.seq},policy_version,'not_qualified',0,0,0,estimated_reading_ms,asset_id,asset_revision,summary,privacy_epoch,recording_generation from evidence.encounter_evidence where universe_id=${p.universeId}::uuid and id=${source.id}::uuid`.execute(
        db,
      );
      const vector = { ...(head.source_vector as Record<string, string | number>), legacyQualificationId: id };
      await db
        .updateTable('evidence.recording_segment_heads')
        .set({ source_vector: JSON.stringify(vector), input_sha256: canonicalSha256(vector) })
        .where('universe_id', '=', p.universeId)
        .where('privacy_epoch', '=', 1)
        .where('exposure_id', '=', e.exposureId)
        .where('recording_generation', '=', gate.scope.generation)
        .execute();
      return id;
    });
    expect(corrected.kind).toBe('entered');
    expect((await proof(p, f.unit)).witnesses).toEqual([]);
    expect(
      await database.db
        .selectFrom('personal_context.recording_coverage_references')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toHaveLength(1);
    await c.projectActivity(job(p, e.exposureId));
    expect(
      await database.db
        .selectFrom('personal_context.recording_coverage_references')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toEqual([]);
    expect(
      await database.db
        .selectFrom('personal_context.recording_segment_heads')
        .select('qualified')
        .where('universe_id', '=', p.universeId)
        .where('exposure_id', '=', e.exposureId)
        .where('recording_generation', '=', 1)
        .executeTakeFirstOrThrow(),
    ).toEqual({ qualified: false });
    expect(
      await database.db
        .selectFrom('personal_context.coverage_supports')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toEqual([]);
  });
  it('retains an exact sealed old-generation certificate while paused and after an unrelated new generation activation', async () => {
    const p = await recordingPerson(database),
      f = await fixture(),
      e = await read(p, f);
    const original = (await proof(p, f.unit)).witnesses;
    expect(original).toHaveLength(1);
    const policy = recordingPolicyFor(database.db, { lockTimeoutMs: 5000 });
    expect(
      await policy.set(p.authority, {
        version: 'recording-policy.v1',
        commandId: randomUUID(),
        expectedPrivacyEpoch: 1,
        expectedRecordingGeneration: 1,
        on: false,
      }),
    ).toMatchObject({ kind: 'ok' });
    expect((await proof(p, f.unit)).witnesses).toEqual(original);
    expect(
      await policy.set(p.authority, {
        version: 'recording-policy.v1',
        commandId: randomUUID(),
        expectedPrivacyEpoch: 1,
        expectedRecordingGeneration: 2,
        on: true,
      }),
    ).toMatchObject({ kind: 'ok' });
    expect(
      await c.activateExposure(p.authority, {
        commandId: randomUUID(),
        exposureId: e.exposureId,
        recordingGeneration: 3,
      }),
    ).toMatchObject({ kind: 'activated' });
    expect(
      await c.projectActivity({
        v: 2,
        universeId: p.universeId,
        privacyEpoch: 1,
        exposureId: e.exposureId,
        recordingGeneration: 3,
      }),
    ).toMatchObject({ kind: 'skipped', reason: 'no_current_source' });
    expect((await proof(p, f.unit)).witnesses).toEqual(original);
    expect(original.every((w) => w.recordingGeneration === 1 && w.sourceKind === 'segment')).toBe(true);
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
  it('proves a support read many times by one witness, the newest exposure (#674)', async () => {
    const p = await seedPerson(database.db),
      f = await fixture();
    const first = await read(p, f),
      second = await read(p, f),
      third = await read(p, f);
    expect(
      await database.db
        .selectFrom('personal_context.coverage_supports')
        .select('reference_count')
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toEqual([{ reference_count: 3 }]);
    const result = await proof(p, f.unit);
    expect([first.exposureId, second.exposureId, third.exposureId]).toContain(result.witnesses[0]?.exposureId);
    expect(result.witnesses).toHaveLength(1);
    expect(result.certificates).toHaveLength(1);
    expect(result.supports).toMatchObject([{ witnessExposureIds: [result.witnesses[0]!.exposureId] }]);
    // The newest is the last read: the quiet rule counts from it.
    const activated = await database.db
      .selectFrom('experience.exposures')
      .select(['id', 'activated_at'])
      .where('id', 'in', [first.exposureId, second.exposureId, third.exposureId])
      .execute();
    const newestRead = activated.sort((a, b) => +new Date(b.activated_at!) - +new Date(a.activated_at!))[0]!;
    expect(result.witnesses[0]!.exposureId).toBe(newestRead.id);
  });
  it('reads a support with more than 1000 raw references and still proves it by its newest exposure (#674)', async () => {
    const p = await seedPerson(database.db),
      f = await fixture(),
      e = await read(p, f);
    await seedOlderRereads(database, p, e.exposureId, 1500);
    const raw = await database.db
      .selectFrom('personal_context.coverage_references')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('universe_id', '=', p.universeId)
      .executeTakeFirstOrThrow();
    expect(raw.n).toBeGreaterThan(1000);
    const result = await proof(p, f.unit);
    expect(result).toMatchObject({ availability: 'available', reason: 'current' });
    expect(result.witnesses).toHaveLength(1);
    expect(result.witnesses[0]).toMatchObject({ exposureId: e.exposureId, sourceKind: 'segment' });
    expect(result.certificates).toHaveLength(1);
    expect((await discovery(p)).probes).toEqual([{ topicId: topic, facetId: facet, explanationUnitId: f.unit }]);
  }, 60_000);
  it('proves a key by an older valid exposure when the newest one is on retracted authority (#674)', async () => {
    const p = await seedPerson(database.db),
      a = await fixture(),
      b = await fixture(a.unit);
    const ea = await read(p, a),
      eb = await read(p, b);
    expect((await proof(p, a.unit)).witnesses.map((w) => w.exposureId)).toEqual([eb.exposureId]);
    await admit()(approved({ ...b.command, expectedHeadRevision: 1, change: { kind: 'retract' } }));
    const result = await proof(p, a.unit);
    expect(result.witnesses.map((w) => w.exposureId)).toEqual([ea.exposureId]);
    expect(result.certificates).toHaveLength(1);
    expect(result.supports).toMatchObject([{ witnessExposureIds: [ea.exposureId] }]);
  });
  it('rolls back the combined projection, bounds proof queries, erases all stores, and fences late reset work', async () => {
    const p = await seedPerson(database.db),
      f = await fixture(),
      e = await read(p, f);
    await admit()(approved({ ...f.command, expectedHeadRevision: 1, change: { kind: 'retract' } }));
    const before = await database.db
      .selectFrom('personal_context.recording_coverage_contributions')
      .selectAll()
      .where('universe_id', '=', p.universeId)
      .execute();
    const failing = await scrollUseCases(database, {
      recording: true,
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
        .selectFrom('personal_context.recording_coverage_contributions')
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
    for (const table of [
      'coverage_references',
      'coverage_supports',
      'coverage_contributions',
      'recording_coverage_references',
      'recording_coverage_contributions',
      'recording_exposure_contributions',
      'recording_segment_heads',
    ] as const)
      expect(
        await database.db
          .selectFrom(`personal_context.${table}`)
          .selectAll()
          .where('universe_id', '=', p.universeId)
          .execute(),
      ).toEqual([]);
  });

  /** #674: a certificate names the head it was issued against, but what it proves does not depend on that head's number or the catalogue digest. */
  const supportRows = (p: FixturePerson) =>
    database.db
      .selectFrom('personal_context.coverage_supports')
      .selectAll()
      .where('universe_id', '=', p.universeId)
      .execute();
  it('keeps observed support on later heads that differ only in the catalogue digest and head number (#674)', async () => {
    const p = await seedPerson(database.db),
      f = await fixture();
    await read(p, f);
    const original = await proof(p, f.unit);
    expect(original.witnesses).toHaveLength(1);
    const supports = await supportRows(p);
    expect(supports).toMatchObject([{ reference_count: 1, facet_id: facet }]);
    await appendDigestOnlyHead(database.db, f, 1);
    await appendDigestOnlyHead(database.db, f, 2);
    // The stored heads differ in the digest alone, as the 54 appended heads on dev did.
    const heads = await database.db
      .selectFrom('content.coverage_revisions')
      .select(['revision', 'mapping'])
      .where('asset_id', '=', f.assetId)
      .orderBy('revision')
      .execute();
    expect(heads.map((h) => h.revision)).toEqual([1, 2, 3]);
    const { catalogueSha256: firstDigest, ...firstReading } = heads[0]!.mapping as CoverageMapping,
      { catalogueSha256: lastDigest, ...lastReading } = heads[2]!.mapping as CoverageMapping;
    expect(lastReading).toEqual(firstReading);
    expect(lastDigest).not.toBe(firstDigest);
    const after = await proof(p, f.unit);
    expect(after).toMatchObject({ availability: 'available', reason: 'current' });
    expect(after.witnesses).toEqual(original.witnesses);
    expect(after.supports).toEqual(original.supports);
    expect(after.certificates[0]?.certificate.mapping).toMatchObject({
      authority: { headRevision: 1 },
      catalogueSha256: firstDigest,
    });
    expect(await supportRows(p)).toEqual(supports);
  });
  it.each([
    [
      'the facet a binding names',
      (f: Awaited<ReturnType<typeof fixture>>): CoverageMapping => ({
        ...f.map,
        bindings: [
          {
            ...f.map.bindings[0]!,
            facetId: otherFacet,
            meaningSha256: coverageCatalogue.meaningSha256(topic, otherFacet)!,
          },
        ],
      }),
    ],
    [
      'the blocks a binding needs',
      (f: Awaited<ReturnType<typeof fixture>>): CoverageMapping => ({
        ...f.map,
        bindings: [{ ...f.map.bindings[0]!, requiredBlockIds: ['intro-look-up'] }],
      }),
    ],
  ])(
    'still excludes the certificate when a head after a digest-only one corrects %s (#674)',
    async (_name, correct) => {
      const p = await seedPerson(database.db),
        f = await fixture();
      await read(p, f);
      await appendDigestOnlyHead(database.db, f, 1);
      expect((await proof(p, f.unit)).witnesses).toHaveLength(1);
      await admit()(
        approved({ ...f.command, expectedHeadRevision: 2, change: { kind: 'admit', mapping: correct(f) } }),
      );
      const result = await proof(p, f.unit);
      expect(result.witnesses).toEqual([]);
      expect(result.supports).toEqual([]);
    },
  );
  it('still excludes the certificate when a head after a digest-only one retracts the mapping (#674)', async () => {
    const p = await seedPerson(database.db),
      f = await fixture();
    await read(p, f);
    await appendDigestOnlyHead(database.db, f, 1);
    expect((await proof(p, f.unit)).witnesses).toHaveLength(1);
    await admit()(approved({ ...f.command, expectedHeadRevision: 2, change: { kind: 'retract' } }));
    expect((await proof(p, f.unit)).witnesses).toEqual([]);
    expect((await proof(p, f.unit)).supports).toEqual([]);
  });
  it('keeps an exact sealed old-generation certificate on an older head while recording is paused (#674)', async () => {
    const p = await recordingPerson(database),
      f = await fixture();
    await read(p, f);
    const original = (await proof(p, f.unit)).witnesses;
    expect(original).toHaveLength(1);
    expect(
      await recordingPolicyFor(database.db, { lockTimeoutMs: 5000 }).set(p.authority, {
        version: 'recording-policy.v1',
        commandId: randomUUID(),
        expectedPrivacyEpoch: 1,
        expectedRecordingGeneration: 1,
        on: false,
      }),
    ).toMatchObject({ kind: 'ok' });
    await appendDigestOnlyHead(database.db, f, 1);
    expect((await proof(p, f.unit)).witnesses).toEqual(original);
  });
  it('holds the current head, not the one the certificate names, until the personal commit (#674)', async () => {
    const p = await seedPerson(database.db),
      f = await fixture();
    await read(p, f);
    await appendDigestOnlyHead(database.db, f, 1);
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
    const correction = admit()(approved({ ...f.command, expectedHeadRevision: 2, change: { kind: 'retract' } }));
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
  it('re-projects a reading after a digest-only head onto the current head without disturbing support counts (#674)', async () => {
    const p = await seedPerson(database.db),
      f = await fixture(),
      e = await read(p, f);
    const original = await proof(p, f.unit),
      supports = await supportRows(p);
    const activity = await database.db
      .selectFrom('evidence.recording_segment_heads')
      .select('activity_id')
      .where('recording_generation', '=', 1)
      .where('universe_id', '=', p.universeId)
      .where('exposure_id', '=', e.exposureId)
      .executeTakeFirstOrThrow();
    await appendDigestOnlyHead(database.db, f, 1);
    expect(await c.projectActivity(job(p, e.exposureId))).toMatchObject({
      kind: 'applied',
      activityId: activity.activity_id,
    });
    const after = await proof(p, f.unit);
    expect(after.supports).toEqual(original.supports);
    expect(after.witnesses[0]?.certificateSha256).not.toBe(original.witnesses[0]?.certificateSha256);
    expect(after.certificates[0]?.certificate.mapping?.authority.headRevision).toBe(2);
    expect(await supportRows(p)).toEqual(supports);
    expect(await c.projectActivity(job(p, e.exposureId))).toEqual({ kind: 'skipped', reason: 'already_applied' });
  });
  it('fences a certificate whose head moved by digest alone after it was prepared, instead of failing the projection (#674)', async () => {
    const p = await seedPerson(database.db),
      f = await fixture(),
      e = await read(p, f);
    const original = await proof(p, f.unit);
    let moved = false;
    // The head moves after Evidence prepared the certificate and before the context effect fences it.
    const racing = await scrollUseCases(database, {
      recording: true,
      activityDerived: {
        ...c.activityContextEffect,
        applyRecording: async (scope, input) => {
          if (!moved) {
            moved = true;
            // A concurrent admission on its own connection, not nested in this personal transaction.
            await outsideTransaction(() => appendDigestOnlyHead(database.db, f, 1));
          }
          return c.activityContextEffect.applyRecording(scope, input);
        },
      },
    });
    try {
      await expect(racing.projectActivity(job(p, e.exposureId))).resolves.toEqual({
        kind: 'skipped',
        reason: 'already_applied',
      });
    } finally {
      await racing.close();
    }
    expect(moved).toBe(true);
    const after = await proof(p, f.unit);
    expect(after.witnesses).toEqual(original.witnesses);
    expect(after.certificates[0]?.certificate.mapping?.authority.headRevision).toBe(1);
  });
});

/** Authored CI sources and a fixture model only. Whether dev's own readers recover is for the coordinator to check there. */
describe("Geography after the catalogue digest of a reader's coverage heads changed (real PostgreSQL CI fixtures)", () => {
  let world: GeographyWorld;
  beforeAll(async () => {
    world = await geographyWorld('personal_coverage_geography');
  });
  afterAll(() => world.close());

  it('forms what the rules entitle from reading whose heads changed by digest alone, not coverage_unavailable (#674)', async () => {
    const { database, coherent, state, context, runner, job, snapshot } = world;
    const p = await seedPerson(database.db);
    const assets = await coherent(p);
    for (const asset of assets) await appendDigestOnlyHead(database.db, asset, 1);
    const runId = (await state(p)).activeRunId;
    if (!runId) throw new Error('CI expected an active Cartographer run');
    // A model that answers nonsense: formation here is the rules' decision.
    await runner(p, () => ({ kind: 'malformed' })).run(await job(p, runId), signal());
    expect((await context(p, runId)).facts.supports.length).toBeGreaterThan(0);
    expect(
      await database.db
        .selectFrom('geography.runs')
        .select(['status', 'outcome'])
        .where('universe_id', '=', p.universeId)
        .where('id', '=', runId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ status: 'accepted', outcome: 'applied_by_rules' });
    const universe = await snapshot(p);
    expect('page' in universe ? universe.page.objects.map((place) => place.kind).sort() : []).toEqual([
      'planet',
      'region',
      'region',
      'star',
      'system',
    ]);
  });
});
