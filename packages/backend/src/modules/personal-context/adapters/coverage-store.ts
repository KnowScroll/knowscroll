import { sql } from 'kysely';
import { canonicalJson, canonicalSha256, utf8ByteLength } from '@knowscroll/scroll-model';
import {
  ObservedCoverageSchema,
  recordingCoverageKey,
  type ObservedCoverage,
  type RecordingActivityDerivedInput,
  type RecordingCoverageWitness,
} from '../../evidence/public.js';
import type { PersonalScopeTx, RecordingScopeTx } from '../../identity/public.js';
import type { CoverageHead } from '../../content/public.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { recordingTransactionOf, fencePersonalRecording } from '../../../infrastructure/postgres/recording-scope.js';
import {
  coverageSupports,
  coverageSupportKey,
  RecordingCoverageSlotsSchema,
  selectedWitnesses,
  type RecordingWitnessPointer,
} from '../domain/coverage.js';
import type { Contribution } from '../domain/context.js';
import type { StoredCoverage, CoverageDependencies } from '../application/coverage-ports.js';

export const coverageDigest = (activityId: string, certificate: ObservedCoverage) =>
  canonicalSha256({ activityId, certificate });
export async function readStoredCoverage(scope: PersonalScopeTx, id: string): Promise<StoredCoverage | undefined> {
  const r = await sql<{
    activity_id: string;
    input_sha256: string;
    payload: unknown;
  }>`select activity_id,input_sha256,payload from personal_context.coverage_contributions where universe_id=${scope.authority.universeId}::uuid and privacy_epoch=${scope.authority.privacyEpoch} and exposure_id=${id}::uuid`.execute(
    transactionOf(scope),
  );
  const row = r.rows[0];
  if (!row) return undefined;
  const certificate = ObservedCoverageSchema.parse(row.payload);
  if (coverageDigest(row.activity_id, certificate) !== row.input_sha256 || certificate.exposureId !== id)
    throw new Error('PERSONAL_COVERAGE_STORED_INVALID');
  return { activityId: row.activity_id, digest: row.input_sha256, certificate };
}
export function certificateMatchesHead(c: ObservedCoverage, head: CoverageHead): boolean {
  if (!c.mapping || head.status !== 'active') return false;
  const { version: _version, bindings, ...identity } = head.mapping;
  return (
    canonicalSha256(c.mapping) === canonicalSha256({ authority: head.authority, ...identity }) &&
    c.factsSha256 === identity.readingFactsSha256 &&
    c.bindings.every((b) => bindings.some((x) => canonicalSha256(x) === canonicalSha256(b)))
  );
}
/** Positive apply holds shared Content authority through commit and repeats Evidence after waits. */
export async function fenceCoverage(scope: PersonalScopeTx, c: ObservedCoverage, p: CoverageDependencies) {
  if (c.availability !== 'available') return;
  if (!c.mapping || !(await p.lockAuthorities(scope, [c.mapping.authority])))
    throw new Error('PERSONAL_COVERAGE_AUTHORITY_CHANGED');
  const current = await p.readMapping(scope, { assetId: c.assetId, assetRevision: c.assetRevision });
  if (
    current.kind !== 'mapped' ||
    !certificateMatchesHead(c, current.head) ||
    !(await p.checkEvidence(scope, [c])).includes(c.exposureId)
  )
    throw new Error('PERSONAL_COVERAGE_AUTHORITY_CHANGED');
}
export async function applyCoverage(
  scope: PersonalScopeTx,
  activityId: string,
  input: ObservedCoverage,
  p: CoverageDependencies,
): Promise<boolean> {
  const gate = await fencePersonalRecording(scope, undefined);
  if (gate.kind !== 'recording') throw new Error('PERSONAL_COVERAGE_RECORDING_REQUIRED');
  const c = ObservedCoverageSchema.parse(input);
  if (c.universeId !== scope.authority.universeId || c.privacyEpoch !== scope.authority.privacyEpoch)
    throw new Error('PERSONAL_COVERAGE_SCOPE_INVALID');
  if (utf8ByteLength(canonicalJson(c)) > 16384) throw new Error('PERSONAL_COVERAGE_LIMIT');
  await fenceCoverage(scope, c, p);
  const previous = await readStoredCoverage(scope, c.exposureId),
    digest = coverageDigest(activityId, c);
  if (previous?.digest === digest) return false;
  const converted = await transactionOf(scope)
    .selectFrom('personal_context.recording_coverage_contributions')
    .select('exposure_id')
    .where('universe_id', '=', scope.authority.universeId)
    .where('exposure_id', '=', c.exposureId)
    .executeTakeFirst();
  if (converted) throw new Error('PERSONAL_COVERAGE_RECORDING_REQUIRED');
  const old = new Map((previous ? coverageSupports(previous.certificate) : []).map((s) => [coverageSupportKey(s), s]));
  const next = new Map(coverageSupports(c).map((s) => [coverageSupportKey(s), s]));
  const changes = [
    ...[...old].filter(([k]) => !next.has(k)).map(([, s]) => ({ ...s, delta: -1 })),
    ...[...next].filter(([k]) => !old.has(k)).map(([, s]) => ({ ...s, delta: 1 })),
  ];
  const db = transactionOf(scope),
    u = scope.authority.universeId,
    e = scope.authority.privacyEpoch;
  for (const s of changes) {
    const r = await sql<{
      reference_count: number;
    }>`select reference_count from personal_context.coverage_supports where universe_id=${u}::uuid and privacy_epoch=${e} and topic_id=${s.topicId} and facet_id=${s.facetId} and meaning_sha256=${s.meaningSha256} and explanation_unit_id=${s.explanationUnitId} and truth_sha256=${s.truthSha256}`.execute(
      db,
    );
    const count = (r.rows[0]?.reference_count ?? 0) + s.delta;
    if (count < 0) throw new Error('PERSONAL_COVERAGE_SUPPORT_UNDERFLOW');
    if (!count)
      await sql`delete from personal_context.coverage_supports where universe_id=${u}::uuid and privacy_epoch=${e} and topic_id=${s.topicId} and facet_id=${s.facetId} and meaning_sha256=${s.meaningSha256} and explanation_unit_id=${s.explanationUnitId} and truth_sha256=${s.truthSha256}`.execute(
        db,
      );
    else
      await sql`insert into personal_context.coverage_supports(universe_id,privacy_epoch,topic_id,facet_id,meaning_sha256,explanation_unit_id,truth_sha256,reference_count) values(${u}::uuid,${e},${s.topicId},${s.facetId},${s.meaningSha256},${s.explanationUnitId},${s.truthSha256},${count}) on conflict(universe_id,privacy_epoch,topic_id,facet_id,meaning_sha256,explanation_unit_id,truth_sha256) do update set reference_count=excluded.reference_count`.execute(
        db,
      );
  }
  await sql`insert into personal_context.coverage_contributions(universe_id,privacy_epoch,exposure_id,activity_id,input_sha256,payload) values(${u}::uuid,${e},${c.exposureId}::uuid,${activityId}::uuid,${digest},${JSON.stringify(c)}::jsonb) on conflict(universe_id,exposure_id) do update set privacy_epoch=excluded.privacy_epoch,activity_id=excluded.activity_id,input_sha256=excluded.input_sha256,payload=excluded.payload`.execute(
    db,
  );
  await sql`delete from personal_context.coverage_references where universe_id=${u}::uuid and exposure_id=${c.exposureId}::uuid`.execute(
    db,
  );
  for (const s of next.values())
    await sql`insert into personal_context.coverage_references(universe_id,privacy_epoch,exposure_id,topic_id,facet_id,meaning_sha256,explanation_unit_id,truth_sha256) values(${u}::uuid,${e},${c.exposureId}::uuid,${s.topicId},${s.facetId},${s.meaningSha256},${s.explanationUnitId},${s.truthSha256})`.execute(
      db,
    );
  return true;
}

export async function readWitness(
  scope: PersonalScopeTx,
  exposureId: string,
  ptr: RecordingWitnessPointer,
): Promise<RecordingCoverageWitness> {
  let certificate: ObservedCoverage;
  if (ptr.sourceKind === 'legacy') {
    const legacy = await readStoredCoverage(scope, exposureId);
    if (!legacy || legacy.activityId !== ptr.activityId) throw new Error('PERSONAL_COVERAGE_SOURCE_MISSING');
    certificate = legacy.certificate;
  } else {
    const r = await transactionOf(scope)
      .selectFrom('personal_context.recording_segment_heads')
      .select(['activity_id', 'qualification_id', 'coverage', 'coverage_sha256'])
      .where('universe_id', '=', scope.authority.universeId)
      .where('privacy_epoch', '=', scope.authority.privacyEpoch)
      .where('exposure_id', '=', exposureId)
      .where('recording_generation', '=', ptr.recordingGeneration)
      .executeTakeFirst();
    if (
      !r ||
      r.activity_id !== ptr.activityId ||
      r.qualification_id !== ptr.qualificationId ||
      r.coverage_sha256 !== ptr.certificateSha256
    )
      throw new Error('PERSONAL_COVERAGE_SOURCE_MISSING');
    certificate = ObservedCoverageSchema.parse(r.coverage);
  }
  if (
    certificate.universeId !== scope.authority.universeId ||
    certificate.privacyEpoch !== scope.authority.privacyEpoch ||
    certificate.exposureId !== exposureId ||
    certificate.evidence?.id !== ptr.qualificationId ||
    canonicalSha256(certificate) !== ptr.certificateSha256
  )
    throw new Error('PERSONAL_COVERAGE_SOURCE_INVALID');
  return {
    version: 'recording-coverage.v1',
    sourceKind: ptr.sourceKind,
    recordingGeneration: ptr.recordingGeneration,
    activityId: ptr.activityId,
    qualificationId: ptr.qualificationId,
    certificateSha256: ptr.certificateSha256,
    certificate,
  };
}
export async function fenceRecordingCoverage(
  scope: PersonalScopeTx,
  w: RecordingCoverageWitness,
  p: CoverageDependencies,
) {
  const c = w.certificate;
  if (c.availability !== 'available' || !c.mapping || !(await p.lockAuthorities(scope, [c.mapping.authority])))
    throw new Error('PERSONAL_COVERAGE_AUTHORITY_CHANGED');
  const current = await p.readMapping(scope, { assetId: c.assetId, assetRevision: c.assetRevision });
  if (
    current.kind !== 'mapped' ||
    !certificateMatchesHead(c, current.head) ||
    !(await p.checkRecordingEvidence(scope, [w])).includes(recordingCoverageKey(w))
  )
    throw new Error('PERSONAL_COVERAGE_AUTHORITY_CHANGED');
}
export async function recordingCoverageCurrent(
  scope: RecordingScopeTx,
  x: RecordingActivityDerivedInput,
  digest: string,
) {
  const row = await recordingTransactionOf(scope)
    .selectFrom('personal_context.recording_segment_heads')
    .select('input_sha256')
    .where('universe_id', '=', scope.personal.authority.universeId)
    .where('privacy_epoch', '=', scope.personal.authority.privacyEpoch)
    .where('exposure_id', '=', x.exposure.exposureId)
    .where('recording_generation', '=', scope.generation)
    .executeTakeFirst();
  const effective = await recordingTransactionOf(scope)
    .selectFrom('personal_context.recording_coverage_contributions')
    .select(['input_sha256', 'working_generation', 'witnesses'])
    .where('universe_id', '=', scope.personal.authority.universeId)
    .where('privacy_epoch', '=', scope.personal.authority.privacyEpoch)
    .where('exposure_id', '=', x.exposure.exposureId)
    .executeTakeFirst();
  return (
    row?.input_sha256 === digest &&
    effective?.working_generation === scope.generation &&
    effective.input_sha256 ===
      canonicalSha256({
        version: 'recording-coverage-input.v1',
        projection: digest,
        generation: scope.generation,
        slots: RecordingCoverageSlotsSchema.parse(effective.witnesses),
      })
  );
}
export async function applyRecordingCoverage(
  scope: RecordingScopeTx,
  x: RecordingActivityDerivedInput,
  current: Contribution,
  digest: string,
  p: CoverageDependencies,
) {
  const db = recordingTransactionOf(scope),
    personal = scope.personal,
    u = personal.authority.universeId,
    epoch = personal.authority.privacyEpoch,
    exposureId = x.exposure.exposureId,
    g = scope.generation,
    s = x.currentSegment;
  const old = await db
    .selectFrom('personal_context.recording_coverage_contributions')
    .select(['working_generation', 'witnesses', 'input_sha256'])
    .where('universe_id', '=', u)
    .where('privacy_epoch', '=', epoch)
    .where('exposure_id', '=', exposureId)
    .executeTakeFirst();
  let slots = old ? RecordingCoverageSlotsSchema.parse(old.witnesses) : [];
  if (old && old.working_generation > g) throw new Error('PERSONAL_COVERAGE_RECORDING_REGRESSION');
  let previous = selectedWitnesses(slots);
  if (!old) {
    const legacy = await readStoredCoverage(personal, exposureId);
    previous = legacy?.certificate.evidence
      ? coverageSupports(legacy.certificate).map((support) => ({
          ...support,
          sourceKind: 'legacy' as const,
          recordingGeneration: 1,
          activityId: legacy.activityId,
          qualificationId: legacy.certificate.evidence!.id,
          certificateSha256: canonicalSha256(legacy.certificate),
        }))
      : [];
  }
  if (!old || old.working_generation !== g) slots = previous.map((base) => ({ base, current: null }));
  // Every update rebuilds current pointers, preserving only the committed generation baseline.
  const bases = slots.flatMap((slot) => (slot.base ? [slot.base] : []));
  const c = s.coverage ? ObservedCoverageSchema.parse(s.coverage) : null;
  if (
    c &&
    (c.universeId !== u ||
      c.privacyEpoch !== epoch ||
      c.exposureId !== exposureId ||
      c.assetId !== x.exposure.assetId ||
      c.assetRevision !== x.exposure.assetRevision ||
      c.explanationUnitId !== x.metadata.explanationUnitId ||
      (c.evidence?.id ?? null) !== (s.qualification?.id ?? null))
  )
    throw new Error('PERSONAL_COVERAGE_RECORDING_IDENTITY');
  const fresh: RecordingWitnessPointer[] =
    c && s.qualified && s.qualification
      ? coverageSupports(c).map((support) => ({
          ...support,
          sourceKind: 'segment',
          recordingGeneration: g,
          activityId: s.activity.id,
          qualificationId: s.qualification!.id,
          certificateSha256: canonicalSha256(c),
        }))
      : [];
  if (fresh.length)
    await fenceRecordingCoverage(
      personal,
      {
        version: 'recording-coverage.v1',
        sourceKind: 'segment',
        recordingGeneration: g,
        activityId: s.activity.id,
        qualificationId: s.qualification!.id,
        certificateSha256: canonicalSha256(c),
        certificate: c!,
      },
      p,
    );
  const key = (w: RecordingWitnessPointer) => JSON.stringify([w.topicId, w.facetId]);
  const merged = new Map<string, { base: RecordingWitnessPointer | null; current: RecordingWitnessPointer | null }>(
    bases.map((base) => [key(base), { base, current: null }]),
  );
  for (const value of fresh) merged.set(key(value), { base: merged.get(key(value))?.base ?? null, current: value });
  const nextSlots = RecordingCoverageSlotsSchema.parse([...merged.values()]);
  if (utf8ByteLength(canonicalJson(nextSlots)) > 32768 || (c && utf8ByteLength(canonicalJson(c)) > 16384))
    throw new Error('PERSONAL_COVERAGE_LIMIT');
  const next = selectedWitnesses(nextSlots),
    coverageHash = c ? canonicalSha256(c) : null;
  const effectiveDigest = canonicalSha256({
    version: 'recording-coverage-input.v1',
    projection: digest,
    generation: g,
    slots: nextSlots,
  });
  if (old?.input_sha256 === effectiveDigest && (await recordingCoverageCurrent(scope, x, digest))) return false;
  // Deferred composite FKs permit replacing this head and its <=16 references atomically.
  await sql`insert into personal_context.recording_segment_heads
    (universe_id,privacy_epoch,exposure_id,recording_generation,activity_id,qualification_id,explanation_unit_id,qualified,contribution,input_sha256,coverage,coverage_sha256)
    values(${u}::uuid,${epoch},${exposureId}::uuid,${g},${s.activity.id}::uuid,${s.qualification?.id ?? null}::uuid,${current.explanationUnitId},${current.qualified},
      ${JSON.stringify(current)}::jsonb,${digest},${c ? JSON.stringify(c) : null}::jsonb,${coverageHash})
    on conflict(universe_id,exposure_id,recording_generation) do update set activity_id=excluded.activity_id,
      qualification_id=excluded.qualification_id,qualified=excluded.qualified,contribution=excluded.contribution,
      input_sha256=excluded.input_sha256,coverage=excluded.coverage,coverage_sha256=excluded.coverage_sha256`.execute(
    db,
  );
  const oldSet = new Map(previous.map((v) => [coverageSupportKey(v), v])),
    nextSet = new Map(next.map((v) => [coverageSupportKey(v), v]));
  await replaceCoverageSupports(personal, oldSet, nextSet);
  await sql`insert into personal_context.recording_coverage_contributions(universe_id,privacy_epoch,exposure_id,working_generation,input_sha256,witnesses)
    values(${u}::uuid,${epoch},${exposureId}::uuid,${g},${effectiveDigest},${JSON.stringify(nextSlots)}::jsonb)
    on conflict(universe_id,exposure_id) do update set working_generation=excluded.working_generation,input_sha256=excluded.input_sha256,witnesses=excluded.witnesses`.execute(
    db,
  );
  await db
    .deleteFrom('personal_context.recording_coverage_references')
    .where('universe_id', '=', u)
    .where('exposure_id', '=', exposureId)
    .execute();
  for (const w of next)
    await db
      .insertInto('personal_context.recording_coverage_references')
      .values({
        universe_id: u,
        privacy_epoch: epoch,
        exposure_id: exposureId,
        topic_id: w.topicId,
        facet_id: w.facetId,
        meaning_sha256: w.meaningSha256,
        explanation_unit_id: w.explanationUnitId,
        truth_sha256: w.truthSha256,
        source_kind: w.sourceKind,
        source_generation: w.recordingGeneration,
        source_activity_id: w.activityId,
        source_qualification_id: w.qualificationId,
        source_certificate_sha256: w.certificateSha256,
        source_segment_generation: w.sourceKind === 'segment' ? w.recordingGeneration : null,
        source_legacy_exposure_id: w.sourceKind === 'legacy' ? exposureId : null,
      })
      .execute();
  return true;
}

async function replaceCoverageSupports(
  scope: PersonalScopeTx,
  old: ReadonlyMap<string, ReturnType<typeof coverageSupports>[number]>,
  next: ReadonlyMap<string, ReturnType<typeof coverageSupports>[number]>,
) {
  const db = transactionOf(scope),
    u = scope.authority.universeId,
    e = scope.authority.privacyEpoch;
  const changes = [
    ...[...old].filter(([k]) => !next.has(k)).map(([, s]) => ({ ...s, delta: -1 })),
    ...[...next].filter(([k]) => !old.has(k)).map(([, s]) => ({ ...s, delta: 1 })),
  ];
  for (const s of changes) {
    const row = await db
      .selectFrom('personal_context.coverage_supports')
      .select('reference_count')
      .where('universe_id', '=', u)
      .where('privacy_epoch', '=', e)
      .where('topic_id', '=', s.topicId)
      .where('facet_id', '=', s.facetId)
      .where('meaning_sha256', '=', s.meaningSha256)
      .where('explanation_unit_id', '=', s.explanationUnitId)
      .where('truth_sha256', '=', s.truthSha256)
      .executeTakeFirst();
    const count = (row?.reference_count ?? 0) + s.delta;
    if (count < 0) throw new Error('PERSONAL_COVERAGE_SUPPORT_UNDERFLOW');
    if (!count)
      await sql`delete from personal_context.coverage_supports where universe_id=${u}::uuid and privacy_epoch=${e} and topic_id=${s.topicId} and facet_id=${s.facetId} and meaning_sha256=${s.meaningSha256} and explanation_unit_id=${s.explanationUnitId} and truth_sha256=${s.truthSha256}`.execute(
        db,
      );
    else
      await sql`insert into personal_context.coverage_supports(universe_id,privacy_epoch,topic_id,facet_id,meaning_sha256,explanation_unit_id,truth_sha256,reference_count)
      values(${u}::uuid,${e},${s.topicId},${s.facetId},${s.meaningSha256},${s.explanationUnitId},${s.truthSha256},${count})
      on conflict(universe_id,privacy_epoch,topic_id,facet_id,meaning_sha256,explanation_unit_id,truth_sha256) do update set reference_count=excluded.reference_count`.execute(
        db,
      );
  }
}
