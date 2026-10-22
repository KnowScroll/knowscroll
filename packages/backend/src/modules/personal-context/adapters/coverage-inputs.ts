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
  }>`select distinct topic_id as "topicId",facet_id as "facetId",explanation_unit_id as "explanationUnitId"
 from personal_context.coverage_references where universe_id=${scope.authority.universeId}::uuid and privacy_epoch=${scope.authority.privacyEpoch}
 order by topic_id,facet_id,explanation_unit_id limit 101`.execute(transactionOf(scope));
  const recording = await sql<{ topicId: string; facetId: string; explanationUnitId: string }>`
    select distinct topic_id as "topicId",facet_id as "facetId",explanation_unit_id as "explanationUnitId"
    from personal_context.recording_coverage_references where universe_id=${scope.authority.universeId}::uuid and privacy_epoch=${scope.authority.privacyEpoch}
    order by topic_id,facet_id,explanation_unit_id limit 101`.execute(transactionOf(scope));
  const union = [
    ...new Map(
      [...legacy.rows, ...recording.rows].map((r) => [JSON.stringify([r.topicId, r.facetId, r.explanationUnitId]), r]),
    ).values(),
  ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const overflow =
    legacy.rows.length > 100 ||
    recording.rows.length > 100 ||
    union.length > 100 ||
    new TextEncoder().encode(JSON.stringify(union)).byteLength > 65536;
  return {
    revision,
    completeness: 'not_asserted',
    availability: overflow ? 'unavailable' : 'available',
    probes: overflow ? [] : union,
  };
};
