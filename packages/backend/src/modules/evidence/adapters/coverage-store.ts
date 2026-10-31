import { z } from 'zod';
import { sql } from 'kysely';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { ObservedCoverageSchema, ReadingCoverageSummarySchema } from '../domain/coverage.js';
import {
  recordingCoverageKey,
  type CheckRecordingCoverageEvidence,
  type CheckCoverageEvidence,
  type ObservedCoveragePorts,
} from '../application/coverage-ports.js';
import { SCROLL_QUALIFICATION_POLICY_V0, SCROLL_RECORDING_QUALIFICATION_POLICY } from '../domain/policy.js';
export const readCoverageEvidence: ObservedCoveragePorts['readEvidence'] = async (
  scope,
  id,
  generation,
  qualificationId,
) => {
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
    from evidence.encounter_evidence where universe_id=${scope.authority.universeId}::uuid and privacy_epoch=${scope.authority.privacyEpoch} and exposure_id=${id}::uuid and recording_generation=${generation ?? 1} and (${generation === undefined} and policy_version='scroll-qualification.v0' or ${generation !== undefined} and (${qualificationId !== undefined} and id=${qualificationId ?? null}::uuid or ${qualificationId === undefined} and id=(select qualification_id from evidence.recording_segment_heads where universe_id=${scope.authority.universeId}::uuid and exposure_id=${id}::uuid and recording_generation=${generation ?? 1}))) order by revision desc limit 1`.execute(
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

const RecordingWitness = z.strictObject({
  version: z.literal('recording-coverage.v1'),
  sourceKind: z.enum(['legacy', 'segment']),
  recordingGeneration: z
    .number()
    .int()
    .positive()
    .max(2147483647)
    .refine((g) => g % 2 === 1),
  activityId: z.uuid(),
  qualificationId: z.uuid(),
  certificateSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  certificate: ObservedCoverageSchema,
});
/** Retained immutable audit identity, including explicit legacy/segment lineage; no latest fallback. */
export const checkRecordingCoverageEvidence: CheckRecordingCoverageEvidence = async (scope, input) => {
  if (input.length > 1000) throw new Error('RECORDING_COVERAGE_QUERY_LIMIT');
  input = z.array(RecordingWitness).max(1000).parse(input);
  const keys = input.map(recordingCoverageKey);
  if (new Set(keys).size !== keys.length) throw new Error('RECORDING_COVERAGE_QUERY_DUPLICATE');
  const accepted: string[] = [];
  for (const w of input) {
    const c = ObservedCoverageSchema.parse(w.certificate);
    if (
      w.version !== 'recording-coverage.v1' ||
      !Number.isSafeInteger(w.recordingGeneration) ||
      w.recordingGeneration < 1 ||
      w.recordingGeneration % 2 !== 1 ||
      w.recordingGeneration > 2147483647 ||
      !['legacy', 'segment'].includes(w.sourceKind) ||
      (w.sourceKind === 'legacy' && w.recordingGeneration !== 1) ||
      canonicalSha256(c) !== w.certificateSha256 ||
      c.universeId !== scope.authority.universeId ||
      c.privacyEpoch !== scope.authority.privacyEpoch ||
      c.availability !== 'available' ||
      c.evidence?.id !== w.qualificationId
    )
      continue;
    const row = (
      await sql<{
        id: string;
        revision: number;
        input_watermark: number;
        policy_version: string;
        qualification: string;
        q: number;
        coverage: number;
        summary: unknown;
        asset_id: string;
        asset_revision: number;
        input_vector: Record<string, string | number>;
        head_activity_id: string | null;
        head_legacy_q: string | null;
        head_session_q: string | null;
      }>`select q.id,q.revision,q.input_watermark,q.policy_version,q.qualification,q.q,q.coverage,q.summary,q.asset_id,q.asset_revision,a.input_vector,
      h.activity_id as head_activity_id,h.source_vector->>'legacyQualificationId' as head_legacy_q,h.source_vector->>'sessionQualificationId' as head_session_q
      from evidence.encounter_evidence q join evidence.activity_revisions a on a.universe_id=q.universe_id and a.exposure_id=q.exposure_id and a.privacy_epoch=q.privacy_epoch and a.recording_generation=q.recording_generation
      left join evidence.recording_segment_heads h on h.universe_id=q.universe_id and h.privacy_epoch=q.privacy_epoch and h.exposure_id=q.exposure_id and h.recording_generation=q.recording_generation
      where q.universe_id=${scope.authority.universeId}::uuid and q.privacy_epoch=${scope.authority.privacyEpoch} and q.exposure_id=${c.exposureId}::uuid and q.recording_generation=${w.recordingGeneration} and q.id=${w.qualificationId}::uuid and a.id=${w.activityId}::uuid and a.policy_version in('activity.v0','activity.v1') limit 1`.execute(
        transactionOf(scope),
      )
    ).rows[0];
    const policy = w.sourceKind === 'legacy' ? SCROLL_QUALIFICATION_POLICY_V0 : SCROLL_RECORDING_QUALIFICATION_POLICY;
    const summary = ReadingCoverageSummarySchema.safeParse(row?.summary);
    if (
      row &&
      // A retained generation keeps its sealed head. Within that same generation, a real
      // descriptor-owned Q move immediately invalidates the old certificate, before PC catches up.
      // Independent legacy-base witnesses never borrow a newer segment's authority.
      (w.sourceKind === 'legacy' ||
        (row.head_activity_id === w.activityId &&
          (row.policy_version === SCROLL_QUALIFICATION_POLICY_V0.version
            ? row.head_legacy_q === w.qualificationId
            : row.head_session_q === w.qualificationId))) &&
      row.qualification === 'qualified' &&
      (row.policy_version === policy.version ||
        (w.sourceKind === 'segment' &&
          w.recordingGeneration === 1 &&
          row.policy_version === SCROLL_QUALIFICATION_POLICY_V0.version)) &&
      row.q >= policy.minQ &&
      row.coverage >= policy.minCoverage &&
      row.revision === c.evidence.revision &&
      row.input_watermark === c.evidence.inputWatermark &&
      row.policy_version === c.evidence.policyVersion &&
      row.asset_id === c.assetId &&
      row.asset_revision === c.assetRevision &&
      canonicalSha256(row.summary) === c.evidence.summarySha256 &&
      summary.success &&
      c.bindings.every((b) => b.requiredBlockIds.every((id) => summary.data.seenBlocks.includes(id))) &&
      (w.sourceKind === 'legacy'
        ? row.input_vector.policy === 'activity.v0' && row.input_vector.qualificationRevision === row.revision
        : row.input_vector.policy === 'recording-credit.v1' &&
          row.input_vector.qualificationId === row.id &&
          row.input_vector.qualificationRevision === row.revision)
    )
      accepted.push(recordingCoverageKey(w));
  }
  return accepted;
};
