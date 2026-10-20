import { sql } from 'kysely';
import { canonicalJson, canonicalSha256, utf8ByteLength } from '@knowscroll/scroll-model';
import { ObservedCoverageSchema, type ObservedCoverage } from '../../evidence/public.js';
import type { CoverageAuthority } from '../../content/public.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import {
  TrustedCoverageQuerySchema,
  coverageSupports,
  coverageSupportKey,
  type TrustedCoverageRead,
} from '../domain/coverage.js';
import type { ReadTrustedCoverage, CoverageDependencies } from '../application/coverage-ports.js';
import { coverageDigest, certificateMatchesHead } from './coverage-store.js';
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
/** Requested current witnesses only. Shared authority locks survive until the caller commits. */
export function makeReadTrustedCoverage(p: CoverageDependencies): ReadTrustedCoverage {
  return async (scope, input) => {
    const q = TrustedCoverageQuerySchema.parse(input);
    if (utf8ByteLength(canonicalJson(q)) > 65536) return unavailable('limit');
    const probes = q.probes.map((x) => ({ topic_id: x.topicId, facet_id: x.facetId, unit: x.explanationUnitId }));
    const rows = await sql<{
      exposure_id: string;
      topic_id: string;
      facet_id: string;
      meaning_sha256: string;
      explanation_unit_id: string;
      truth_sha256: string;
      activity_id: string;
      input_sha256: string;
      payload: unknown;
    }>`select r.*,c.activity_id,c.input_sha256,c.payload
    from jsonb_to_recordset(${JSON.stringify(probes)}::jsonb) as probe(topic_id text,facet_id text,unit text)
    cross join lateral (select * from personal_context.coverage_references where universe_id=${scope.authority.universeId}::uuid and privacy_epoch=${scope.authority.privacyEpoch} and topic_id=probe.topic_id and facet_id=probe.facet_id and explanation_unit_id=probe.unit order by exposure_id limit 1001) r
    join personal_context.coverage_contributions c on c.universe_id=r.universe_id and c.privacy_epoch=r.privacy_epoch and c.exposure_id=r.exposure_id limit 1001`.execute(
      transactionOf(scope),
    );
    if (rows.rows.length > 1000) return unavailable('limit');
    const certificates = new Map<string, { certificate: ObservedCoverage; digest: string }>();
    for (const r of rows.rows) {
      const c = ObservedCoverageSchema.parse(r.payload);
      if (
        c.universeId !== scope.authority.universeId ||
        c.privacyEpoch !== scope.authority.privacyEpoch ||
        c.exposureId !== r.exposure_id ||
        coverageDigest(r.activity_id, c) !== r.input_sha256
      )
        throw new Error('PERSONAL_COVERAGE_STORED_INVALID');
      certificates.set(c.exposureId, { certificate: c, digest: canonicalSha256(c) });
    }
    const list = [...certificates.values()].map((x) => x.certificate);
    const currentEvidence = new Set(await p.checkEvidence(scope, list));
    const refs = new Map<string, { assetId: string; assetRevision: number }>();
    for (const c of list)
      if (currentEvidence.has(c.exposureId))
        refs.set(`${c.assetId}@${String(c.assetRevision)}`, { assetId: c.assetId, assetRevision: c.assetRevision });
    if (refs.size > 100) return unavailable('limit');
    const currentMaps = new Map<string, Awaited<ReturnType<CoverageDependencies['readMapping']>>>();
    for (const [key, ref] of refs) currentMaps.set(key, await p.readMapping(scope, ref));
    const valid = list.filter((c) => {
      const m = currentMaps.get(`${c.assetId}@${String(c.assetRevision)}`);
      return currentEvidence.has(c.exposureId) && m?.kind === 'mapped' && certificateMatchesHead(c, m.head);
    });
    const authorities = new Map<string, CoverageAuthority>();
    for (const c of valid) authorities.set(`${c.assetId}@${String(c.assetRevision)}`, c.mapping!.authority);
    if (authorities.size && !(await p.lockAuthorities(scope, [...authorities.values()])))
      return unavailable('authority_changed');
    // Repeat after lock waits. The personal root prevents another evidence projection throughout.
    const checkedAgain = new Set(await p.checkEvidence(scope, valid));
    if (valid.some((c) => !checkedAgain.has(c.exposureId))) return unavailable('authority_changed');
    const validIds = new Set(valid.map((c) => c.exposureId));
    const witnesses = rows.rows
      .filter(
        (r) =>
          validIds.has(r.exposure_id) &&
          coverageSupports(certificates.get(r.exposure_id)!.certificate).some(
            (s) =>
              coverageSupportKey(s) ===
              coverageSupportKey({
                topicId: r.topic_id,
                facetId: r.facet_id,
                meaningSha256: r.meaning_sha256,
                explanationUnitId: r.explanation_unit_id,
                truthSha256: r.truth_sha256,
              }),
          ),
      )
      .map((r) => ({
        exposureId: r.exposure_id,
        topicId: r.topic_id,
        facetId: r.facet_id,
        meaningSha256: r.meaning_sha256,
        explanationUnitId: r.explanation_unit_id,
        truthSha256: r.truth_sha256,
        certificateSha256: certificates.get(r.exposure_id)!.digest,
      }));
    if (!witnesses.length) return unavailable('not_observed');
    // One canonical semantic support key, regardless of repeated/variant source witnesses.
    const groups = new Map<string, { support: ReturnType<typeof coverageSupports>[number]; exposures: Set<string> }>();
    for (const w of witnesses) {
      const support = {
        topicId: w.topicId,
        facetId: w.facetId,
        meaningSha256: w.meaningSha256,
        explanationUnitId: w.explanationUnitId,
        truthSha256: w.truthSha256,
      };
      const key = coverageSupportKey(support),
        group = groups.get(key) ?? { support, exposures: new Set<string>() };
      group.exposures.add(w.exposureId);
      groups.set(key, group);
    }
    const supports = [...groups]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, g]) => ({ ...g.support, witnessExposureIds: [...g.exposures].sort() }));
    witnesses.sort((a, b) => {
      const x = coverageSupportKey(a),
        y = coverageSupportKey(b);
      return x < y ? -1 : x > y ? 1 : a.exposureId < b.exposureId ? -1 : a.exposureId > b.exposureId ? 1 : 0;
    });
    const used = new Set(witnesses.map((w) => w.exposureId));
    const result: TrustedCoverageRead<ObservedCoverage> = {
      ...base,
      availability: 'available',
      reason: 'current',
      supports,
      witnesses,
      certificates: valid
        .filter((c) => used.has(c.exposureId))
        .sort((a, b) => (a.exposureId < b.exposureId ? -1 : a.exposureId > b.exposureId ? 1 : 0))
        .map((c) => ({ certificateSha256: certificates.get(c.exposureId)!.digest, certificate: c })),
    };
    return utf8ByteLength(canonicalJson(result)) > 131072 ? unavailable('limit') : result;
  };
}
