import { sql } from 'kysely';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { ReadCoverageInputs } from '../public.js';
import { readContextRevision } from './postgres-store.js';
/** Candidate discovery only. The separate current trusted read must fence every actual apply. */
export const readCoverageInputs: ReadCoverageInputs = async (scope) => {
  const { revision } = await readContextRevision(scope);
  const legacy = await sql<{
    topicId: string;
    facetId: string;
    explanationUnitId: string;
  }>`select topic_id as "topicId",facet_id as "facetId",explanation_unit_id as "explanationUnitId"
 from personal_context.coverage_references where universe_id=${scope.authority.universeId}::uuid and privacy_epoch=${scope.authority.privacyEpoch}
 order by topic_id,facet_id,explanation_unit_id,exposure_id limit 1001`.execute(transactionOf(scope));
  const recording = await sql<{ topicId: string; facetId: string; explanationUnitId: string }>`
    select topic_id as "topicId",facet_id as "facetId",explanation_unit_id as "explanationUnitId"
    from personal_context.recording_coverage_references where universe_id=${scope.authority.universeId}::uuid and privacy_epoch=${scope.authority.privacyEpoch}
    order by topic_id,facet_id,explanation_unit_id,exposure_id limit 1001`.execute(transactionOf(scope));
  // Count raw references before key deduplication. Duplicate keys cannot hide an arbitrarily
  // long source history or cause a refill scan while the caller holds its personal root.
  if (legacy.rows.length > 1000 || recording.rows.length > 1000 || legacy.rows.length + recording.rows.length > 1000)
    return { revision, completeness: 'not_asserted', availability: 'unavailable', reason: 'limit', probes: [] };
  const union = [
    ...new Map(
      [...legacy.rows, ...recording.rows].map((r) => [JSON.stringify([r.topicId, r.facetId, r.explanationUnitId]), r]),
    ).values(),
  ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const overflow = union.length > 100 || new TextEncoder().encode(JSON.stringify(union)).byteLength > 65536;
  return {
    revision,
    completeness: 'not_asserted',
    availability: overflow ? 'unavailable' : 'available',
    reason: overflow ? 'limit' : 'bounded',
    probes: overflow ? [] : union,
  };
};
