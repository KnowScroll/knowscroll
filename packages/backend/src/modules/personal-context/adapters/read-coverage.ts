import { sql } from 'kysely';
import { canonicalJson, canonicalSha256, utf8ByteLength } from '@knowscroll/scroll-model';
import {
  ObservedCoverageSchema,
  recordingCoverageKey,
  type ObservedCoverage,
  type RecordingCoverageWitness,
} from '../../evidence/public.js';
import type { CoverageAuthority } from '../../content/public.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import {
  TrustedCoverageQuerySchema,
  coverageSupports,
  coverageSupportKey,
  newestWitnessPerSupport,
  RecordingWitnessPointerSchema,
  type TrustedCoverageRead,
} from '../domain/coverage.js';
import { certificateValidOnHead, sameCoverageAuthority } from './coverage-rule.js';
import type { ReadTrustedCoverage, CoverageDependencies } from '../application/coverage-ports.js';
import { coverageDigest, readWitness } from './coverage-store.js';
const base = {
  version: 'trusted-coverage-read.v1',
  completeness: 'not_asserted',
  supportedFormats: ['scroll'],
} as const;
const unavailable = (
  reason: 'limit' | 'authority_changed' | 'not_observed',
): TrustedCoverageRead<ObservedCoverage> => ({
  ...base,
  availability: 'unavailable',
  reason,
  supports: [],
  witnesses: [],
  certificates: [],
});
interface Reference {
  exposure_id: string;
  topic_id: string;
  facet_id: string;
  meaning_sha256: string;
  explanation_unit_id: string;
  truth_sha256: string;
}
/**
 * What one support key puts forward as witnesses: up to eight exposures of the key, however its
 * references are spread over asset revisions. They are taken round by round: the newest exposure of
 * each asset revision first (the newest revision first), then the second newest of each, and so on.
 * Each candidate is checked in full and the newest that is valid proves the key. Re-reading one Scroll
 * a thousand times adds references to a key but never candidates, so the read neither refuses nor
 * grows with how much a person has read. Several asset revisions can carry one explanation unit
 * (variants, a corrected revision), and each gets a candidate before any gets a second, so a
 * withdrawn newest revision does not hide a valid older one. A key read under one revision gets its
 * eight newest exposures, so a run of invalid newest certificates (a head changed and re-admitted)
 * does not hide a valid older one either.
 */
const CANDIDATES_PER_KEY = 8;

export function makeReadTrustedCoverage(p: CoverageDependencies): ReadTrustedCoverage {
  return async (scope, input) => {
    const q = TrustedCoverageQuerySchema.parse(input);
    if (utf8ByteLength(canonicalJson(q)) > 65536) return unavailable('limit');
    const db = transactionOf(scope),
      u = scope.authority.universeId,
      epoch = scope.authority.privacyEpoch,
      probes = JSON.stringify(
        q.probes.map((x) => ({ topic_id: x.topicId, facet_id: x.facetId, unit: x.explanationUnitId })),
      );
    const legacy = await sql<
      Reference & { activity_id: string; input_sha256: string; payload: unknown }
    >`with probe as (select * from jsonb_to_recordset(${probes}::jsonb) as probe(topic_id text,facet_id text,unit text)),
      refs as (
        select r.exposure_id,r.topic_id,r.facet_id,r.meaning_sha256,r.explanation_unit_id,r.truth_sha256,
          c.activity_id,c.input_sha256,c.payload,
          (c.payload->>'activatedAt')::timestamptz as activated_at,
          c.payload->>'assetId' as asset_id,c.payload->>'assetRevision' as asset_revision
        from probe
        join personal_context.coverage_references r on r.universe_id=${u}::uuid and r.privacy_epoch=${epoch}
          and r.topic_id=probe.topic_id and r.facet_id=probe.facet_id and r.explanation_unit_id=probe.unit
        join personal_context.coverage_contributions c on c.universe_id=r.universe_id and c.privacy_epoch=r.privacy_epoch and c.exposure_id=r.exposure_id
        where not exists (select 1 from personal_context.recording_coverage_contributions rc
          where rc.universe_id=r.universe_id and rc.privacy_epoch=r.privacy_epoch and rc.exposure_id=r.exposure_id)),
      per_revision as (
        select refs.*,row_number() over (partition by topic_id,facet_id,explanation_unit_id,meaning_sha256,truth_sha256,asset_id,asset_revision
          order by activated_at desc nulls last,exposure_id desc) as in_revision from refs),
      per_key as (
        select per_revision.*,row_number() over (partition by topic_id,facet_id,explanation_unit_id,meaning_sha256,truth_sha256
          order by in_revision,activated_at desc nulls last,exposure_id desc) as newest
        from per_revision)
      select exposure_id,topic_id,facet_id,meaning_sha256,explanation_unit_id,truth_sha256,activity_id,input_sha256,payload
      from per_key where newest<=${CANDIDATES_PER_KEY} limit 1001`.execute(db);
    const recording = await sql<
      Reference & {
        source_kind: string;
        source_generation: number;
        source_activity_id: string;
        source_qualification_id: string;
        source_certificate_sha256: string;
      }
    >`with probe as (select * from jsonb_to_recordset(${probes}::jsonb) as probe(topic_id text,facet_id text,unit text)),
      refs as (
        select r.exposure_id,r.topic_id,r.facet_id,r.meaning_sha256,r.explanation_unit_id,r.truth_sha256,
          r.source_kind,r.source_generation,r.source_activity_id,r.source_qualification_id,r.source_certificate_sha256,
          coalesce(h.coverage,lc.payload) as certificate
        from probe
        join personal_context.recording_coverage_references r on r.universe_id=${u}::uuid and r.privacy_epoch=${epoch}
          and r.topic_id=probe.topic_id and r.facet_id=probe.facet_id and r.explanation_unit_id=probe.unit
        left join personal_context.recording_segment_heads h on r.source_kind='segment' and h.universe_id=r.universe_id
          and h.exposure_id=r.exposure_id and h.recording_generation=r.source_segment_generation
        left join personal_context.coverage_contributions lc on r.source_kind='legacy' and lc.universe_id=r.universe_id
          and lc.privacy_epoch=r.privacy_epoch and lc.exposure_id=r.exposure_id),
      dated as (
        select refs.*,(certificate->>'activatedAt')::timestamptz as activated_at,
          certificate->>'assetId' as asset_id,certificate->>'assetRevision' as asset_revision from refs),
      per_revision as (
        select dated.*,row_number() over (partition by topic_id,facet_id,explanation_unit_id,meaning_sha256,truth_sha256,asset_id,asset_revision
          order by activated_at desc nulls last,exposure_id desc) as in_revision from dated),
      per_key as (
        select per_revision.*,row_number() over (partition by topic_id,facet_id,explanation_unit_id,meaning_sha256,truth_sha256
          order by in_revision,activated_at desc nulls last,exposure_id desc) as newest
        from per_revision)
      select exposure_id,topic_id,facet_id,meaning_sha256,explanation_unit_id,truth_sha256,
        source_kind,source_generation,source_activity_id,source_qualification_id,source_certificate_sha256
      from per_key where newest<=${CANDIDATES_PER_KEY} limit 1001`.execute(db);
    // Candidates are bounded per key, so this refuses only a batch of probes that is itself too wide;
    // the consumer then reads it as two.
    if (legacy.rows.length > 1000 || recording.rows.length > 1000 || legacy.rows.length + recording.rows.length > 1000)
      return unavailable('limit');
    const sources = new Map<string, { witness: RecordingCoverageWitness; legacyCurrent: boolean }>();
    const refs: { reference: Reference; key: string }[] = [];
    for (const r of legacy.rows) {
      const c = ObservedCoverageSchema.parse(r.payload);
      if (
        c.universeId !== u ||
        c.privacyEpoch !== epoch ||
        c.exposureId !== r.exposure_id ||
        coverageDigest(r.activity_id, c) !== r.input_sha256
      )
        throw new Error('PERSONAL_COVERAGE_STORED_INVALID');
      if (!c.evidence) continue;
      const w: RecordingCoverageWitness = {
        version: 'recording-coverage.v1',
        sourceKind: 'legacy',
        recordingGeneration: 1,
        activityId: r.activity_id,
        qualificationId: c.evidence.id,
        certificateSha256: canonicalSha256(c),
        certificate: c,
      };
      const key = recordingCoverageKey(w);
      sources.set(key, { witness: w, legacyCurrent: true });
      refs.push({ reference: r, key });
    }
    // Hydration is finite (<=1000 rows); duplicate complete witness identities reuse one source.
    const pointerSources = new Map<string, RecordingCoverageWitness>();
    for (const r of recording.rows) {
      const ptr = RecordingWitnessPointerSchema.parse({
        topicId: r.topic_id,
        facetId: r.facet_id,
        meaningSha256: r.meaning_sha256,
        explanationUnitId: r.explanation_unit_id,
        truthSha256: r.truth_sha256,
        sourceKind: r.source_kind,
        recordingGeneration: r.source_generation,
        activityId: r.source_activity_id,
        qualificationId: r.source_qualification_id,
        certificateSha256: r.source_certificate_sha256,
      });
      const id = JSON.stringify([
        r.exposure_id,
        ptr.sourceKind,
        ptr.recordingGeneration,
        ptr.activityId,
        ptr.qualificationId,
        ptr.certificateSha256,
      ]);
      const w = pointerSources.get(id) ?? (await readWitness(scope, r.exposure_id, ptr));
      pointerSources.set(id, w);
      const key = recordingCoverageKey(w);
      sources.set(key, { witness: w, legacyCurrent: false });
      refs.push({ reference: r, key });
    }
    const all = [...sources.values()],
      retained = all.filter((s) => !s.legacyCurrent).map((s) => s.witness),
      current = all.filter((s) => s.legacyCurrent).map((s) => s.witness.certificate);
    const exact = new Set(await p.checkRecordingEvidence(scope, retained)),
      legacyIds = new Set(await p.checkEvidence(scope, current));
    const valid = all.filter((s) =>
      s.legacyCurrent ? legacyIds.has(s.witness.certificate.exposureId) : exact.has(recordingCoverageKey(s.witness)),
    );
    const assets = new Map<string, { assetId: string; assetRevision: number }>();
    for (const {
      witness: { certificate: c },
    } of valid)
      assets.set(`${c.assetId}@${String(c.assetRevision)}`, { assetId: c.assetId, assetRevision: c.assetRevision });
    if (assets.size > 100) return unavailable('limit');
    const maps = new Map<string, Awaited<ReturnType<CoverageDependencies['readMapping']>>>();
    for (const [key, ref] of assets) maps.set(key, await p.readMapping(scope, ref));
    const mapped = valid.filter(({ witness: { certificate: c } }) => {
      const m = maps.get(`${c.assetId}@${String(c.assetRevision)}`);
      return m?.kind === 'mapped' && certificateValidOnHead(c, m.head);
    });
    // A certificate may have been issued against an older head. Lock the head it was just found valid
    // on, the one already read, not the authority the certificate carries (#674).
    const authorities = new Map<string, CoverageAuthority>();
    for (const {
      witness: { certificate: c },
    } of mapped) {
      const key = `${c.assetId}@${String(c.assetRevision)}`,
        m = maps.get(key);
      if (m?.kind === 'mapped') authorities.set(key, m.head.authority);
    }
    if (authorities.size && !(await p.lockAuthorities(scope, [...authorities.values()])))
      return unavailable('authority_changed');
    // Full composite identity survives waits; current Content is checked again under held SHARE locks.
    const again = new Set(
        await p.checkRecordingEvidence(
          scope,
          mapped.filter((s) => !s.legacyCurrent).map((s) => s.witness),
        ),
      ),
      legacyAgain = new Set(
        await p.checkEvidence(
          scope,
          mapped.filter((s) => s.legacyCurrent).map((s) => s.witness.certificate),
        ),
      );
    const mapsAfterWait = new Map<string, Awaited<ReturnType<CoverageDependencies['readMapping']>>>();
    for (const [key, ref] of assets) mapsAfterWait.set(key, await p.readMapping(scope, ref));
    for (const s of mapped) {
      const c = s.witness.certificate,
        key = `${c.assetId}@${String(c.assetRevision)}`,
        locked = authorities.get(key),
        m = mapsAfterWait.get(key);
      if (
        (s.legacyCurrent ? !legacyAgain.has(c.exposureId) : !again.has(recordingCoverageKey(s.witness))) ||
        m?.kind !== 'mapped' ||
        !locked ||
        !sameCoverageAuthority(m.head.authority, locked) ||
        !certificateValidOnHead(c, m.head)
      )
        return unavailable('authority_changed');
    }
    const available = new Map(mapped.map((s) => [recordingCoverageKey(s.witness), s.witness]));
    const proven = refs.flatMap(({ reference: r, key }) => {
      const w = available.get(key);
      if (!w) return [];
      const support = {
        topicId: r.topic_id,
        facetId: r.facet_id,
        meaningSha256: r.meaning_sha256,
        explanationUnitId: r.explanation_unit_id,
        truthSha256: r.truth_sha256,
      };
      if (!coverageSupports(w.certificate).some((s) => coverageSupportKey(s) === coverageSupportKey(support)))
        return [];
      return [
        {
          ...support,
          exposureId: r.exposure_id,
          sourceKind: w.sourceKind,
          recordingGeneration: w.recordingGeneration,
          activityId: w.activityId,
          qualificationId: w.qualificationId,
          certificateSha256: w.certificateSha256,
          witnessKey: key,
        },
      ];
    });
    // One witness per support key, the newest valid one. Variety is by distinct units, never by the
    // number of exposures, so the others are not returned and a re-read adds nothing to the proof.
    const witnesses = newestWitnessPerSupport(proven, (w) => available.get(w.witnessKey)!.certificate.activatedAt);
    if (!witnesses.length) return unavailable('not_observed');
    const supports = witnesses
      .map((w) => ({
        topicId: w.topicId,
        facetId: w.facetId,
        meaningSha256: w.meaningSha256,
        explanationUnitId: w.explanationUnitId,
        truthSha256: w.truthSha256,
        witnessExposureIds: [w.exposureId],
      }))
      .sort((a, b) => coverageSupportKey(a).localeCompare(coverageSupportKey(b)));
    witnesses.sort(
      (a, b) => coverageSupportKey(a).localeCompare(coverageSupportKey(b)) || a.witnessKey.localeCompare(b.witnessKey),
    );
    const used = new Set(witnesses.map((w) => w.witnessKey));
    const result: TrustedCoverageRead<ObservedCoverage> = {
      ...base,
      availability: 'available',
      reason: 'current',
      supports,
      witnesses,
      certificates: [...available]
        .filter(([key]) => used.has(key))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, w]) => ({
          witnessKey: key,
          sourceKind: w.sourceKind,
          recordingGeneration: w.recordingGeneration,
          activityId: w.activityId,
          qualificationId: w.qualificationId,
          certificateSha256: w.certificateSha256,
          certificate: w.certificate,
        })),
    };
    return utf8ByteLength(canonicalJson(result)) > 131072 ? unavailable('limit') : result;
  };
}
