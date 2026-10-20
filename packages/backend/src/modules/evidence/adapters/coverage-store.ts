import { sql } from 'kysely';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { ObservedCoverageSchema, ReadingCoverageSummarySchema } from '../domain/coverage.js';
import type { CheckCoverageEvidence, ObservedCoveragePorts } from '../application/coverage-ports.js';
import { SCROLL_QUALIFICATION_POLICY_V0 } from '../domain/policy.js';
export const readCoverageEvidence: ObservedCoveragePorts['readEvidence'] = async (scope, id) => {
  const rows = await sql<{
    id: string;
    revision: number;
    input_watermark: number;
    policy_version: string;
    asset_id: string;
    asset_revision: number;
    qualification: string;
    q: number;
    coverage: number;
    estimated_reading_ms: number;
    summary: unknown;
  }>`select id,revision,input_watermark,policy_version,asset_id,asset_revision,qualification,q,coverage,estimated_reading_ms,summary
    from evidence.encounter_evidence where universe_id=${scope.authority.universeId}::uuid and privacy_epoch=${scope.authority.privacyEpoch} and exposure_id=${id}::uuid order by revision desc limit 1`.execute(
    transactionOf(scope),
  );
  const r = rows.rows[0];
  return r
    ? {
        id: r.id,
        revision: r.revision,
        inputWatermark: r.input_watermark,
        policyVersion: r.policy_version,
        assetId: r.asset_id,
        assetRevision: r.asset_revision,
        qualification: r.qualification,
        q: r.q,
        coverage: r.coverage,
        estimatedReadingMs: r.estimated_reading_ms,
        summary: r.summary,
      }
    : undefined;
};
/** Evidence owns its table; the PC consumer receives only exact current-certificate identities. */
export const checkCoverageEvidence: CheckCoverageEvidence = async (scope, input) => {
  if (input.length > 1000) throw new Error('COVERAGE_EVIDENCE_QUERY_LIMIT');
  const certificates = input.map((c) => ObservedCoverageSchema.parse(c));
  if (new Set(certificates.map((c) => c.exposureId)).size !== certificates.length)
    throw new Error('COVERAGE_EVIDENCE_QUERY_DUPLICATE');
  if (!certificates.length) return [];
  const rows = await sql<{
    exposure_id: string;
    id: string;
    revision: number;
    input_watermark: number;
    policy_version: string;
    qualification: string;
    asset_id: string;
    asset_revision: number;
    summary: unknown;
    q: number;
    coverage: number;
  }>`select r.* from unnest(${certificates.map((c) => c.exposureId)}::uuid[]) candidate(id)
    cross join lateral (select exposure_id,id,revision,input_watermark,policy_version,qualification,asset_id,asset_revision,summary,q,coverage from evidence.encounter_evidence where universe_id=${scope.authority.universeId}::uuid and privacy_epoch=${scope.authority.privacyEpoch} and exposure_id=candidate.id order by revision desc limit 1) r`.execute(
    transactionOf(scope),
  );
  const byId = new Map(rows.rows.map((r) => [r.exposure_id, r]));
  return certificates
    .filter((c) => {
      const r = byId.get(c.exposureId),
        e = c.evidence,
        p = SCROLL_QUALIFICATION_POLICY_V0;
      const summary = ReadingCoverageSummarySchema.safeParse(r?.summary);
      return (
        c.universeId === scope.authority.universeId &&
        c.privacyEpoch === scope.authority.privacyEpoch &&
        c.availability === 'available' &&
        e &&
        r &&
        r.id === e.id &&
        r.revision === e.revision &&
        r.input_watermark === e.inputWatermark &&
        r.policy_version === e.policyVersion &&
        r.policy_version === p.version &&
        r.qualification === 'qualified' &&
        r.q >= p.minQ &&
        r.coverage >= p.minCoverage &&
        r.asset_id === c.assetId &&
        r.asset_revision === c.assetRevision &&
        summary.success &&
        c.bindings.every((b) => b.requiredBlockIds.every((id) => summary.data.seenBlocks.includes(id))) &&
        canonicalSha256(r.summary) === e.summarySha256
      );
    })
    .map((c) => c.exposureId);
};
