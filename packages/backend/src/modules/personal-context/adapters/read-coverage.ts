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
  RecordingWitnessPointerSchema,
  type TrustedCoverageRead,
} from '../domain/coverage.js';
import type { ReadTrustedCoverage, CoverageDependencies } from '../application/coverage-ports.js';
import { coverageDigest, certificateMatchesHead, readWitness } from './coverage-store.js';
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
/** Both indexed source budgets are fixed BEFORE shadow resolution/certificate hydration. */
export function makeReadTrustedCoverage(p: CoverageDependencies): ReadTrustedCoverage {
  return async (scope, input) => {
    const q = TrustedCoverageQuerySchema.parse(input);
    if (utf8ByteLength(canonicalJson(q)) > 65536) return unavailable('limit');
    const db = transactionOf(scope),
      u = scope.authority.universeId,
      epoch = scope.authority.privacyEpoch,
      probes = q.probes.map((x) => ({ topic_id: x.topicId, facet_id: x.facetId, unit: x.explanationUnitId }));
    const legacy = await sql<
      Reference & { activity_id: string; input_sha256: string; payload: unknown }
    >`select r.*,c.activity_id,c.input_sha256,c.payload
      from jsonb_to_recordset(${JSON.stringify(probes)}::jsonb) probe(topic_id text,facet_id text,unit text)
      cross join lateral(select * from personal_context.coverage_references where universe_id=${u}::uuid and privacy_epoch=${epoch}
      and topic_id=probe.topic_id and facet_id=probe.facet_id and explanation_unit_id=probe.unit order by exposure_id limit 1001) r
      join personal_context.coverage_contributions c on c.universe_id=r.universe_id and c.privacy_epoch=r.privacy_epoch and c.exposure_id=r.exposure_id limit 1001`.execute(
      db,
    );
    const recording = await sql<
      Reference & {
        source_kind: string;
        source_generation: number;
        source_activity_id: string;
        source_qualification_id: string;
        source_certificate_sha256: string;
      }
    >`
      select r.* from jsonb_to_recordset(${JSON.stringify(probes)}::jsonb) probe(topic_id text,facet_id text,unit text)
      cross join lateral(select * from personal_context.recording_coverage_references where universe_id=${u}::uuid and privacy_epoch=${epoch}
      and topic_id=probe.topic_id and facet_id=probe.facet_id and explanation_unit_id=probe.unit order by exposure_id limit 1001) r limit 1001`.execute(
      db,
    );
    if (legacy.rows.length > 1000 || recording.rows.length > 1000 || legacy.rows.length + recording.rows.length > 1000)
      return unavailable('limit');
    const ids = [...new Set(legacy.rows.map((r) => r.exposure_id))];
    const converted = ids.length
      ? await db
          .selectFrom('personal_context.recording_coverage_contributions')
          .select('exposure_id')
          .where('universe_id', '=', u)
          .where('privacy_epoch', '=', epoch)
          .where('exposure_id', 'in', ids)
          .limit(1000)
          .execute()
      : [];
    const shadowed = new Set(converted.map((r) => r.exposure_id));
    const sources = new Map<string, { witness: RecordingCoverageWitness; legacyCurrent: boolean }>();
    const refs: { reference: Reference; key: string }[] = [];
    for (const r of legacy.rows) {
      if (shadowed.has(r.exposure_id)) continue;
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
      return m?.kind === 'mapped' && certificateMatchesHead(c, m.head);
    });
    const authorities = new Map<string, CoverageAuthority>();
    for (const {
      witness: { certificate: c },
    } of mapped)
      authorities.set(`${c.assetId}@${String(c.assetRevision)}`, c.mapping!.authority);
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
        m = mapsAfterWait.get(`${c.assetId}@${String(c.assetRevision)}`);
      if (
        (s.legacyCurrent ? !legacyAgain.has(c.exposureId) : !again.has(recordingCoverageKey(s.witness))) ||
        m?.kind !== 'mapped' ||
        !certificateMatchesHead(c, m.head)
      )
        return unavailable('authority_changed');
    }
    const available = new Map(mapped.map((s) => [recordingCoverageKey(s.witness), s.witness]));
    const witnesses = refs.flatMap(({ reference: r, key }) => {
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
    if (!witnesses.length) return unavailable('not_observed');
    const groups = new Map<string, { support: ReturnType<typeof coverageSupports>[number]; exposures: Set<string> }>();
    for (const w of witnesses) {
      const key = coverageSupportKey(w),
        group = groups.get(key) ?? {
          support: {
            topicId: w.topicId,
            facetId: w.facetId,
            meaningSha256: w.meaningSha256,
            explanationUnitId: w.explanationUnitId,
            truthSha256: w.truthSha256,
          },
          exposures: new Set<string>(),
        };
      group.exposures.add(w.exposureId);
      groups.set(key, group);
    }
    const supports = [...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, g]) => ({ ...g.support, witnessExposureIds: [...g.exposures].sort() }));
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
