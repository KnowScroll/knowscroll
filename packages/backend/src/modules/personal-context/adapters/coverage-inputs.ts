import { sql } from 'kysely';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { ReadCoverageInputs } from '../public.js';
import { readContextRevision } from './postgres-store.js';

/** Distinct support keys one discovery returns; a consumer reads them in batches of 100. */
const MAX_DISCOVERY_KEYS = 1000;
const MAX_DISCOVERY_BYTES = 262144;

const ordinal = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Candidate discovery only. The separate current trusted read must fence every actual apply.
 *
 * It lists the distinct (topic, facet, explanation unit) keys the person's projection holds, from
 * `coverage_supports`: one row per support key however many times it was read, kept in step with the
 * references by both projections (#674). Re-reading a Scroll adds exposures and references, never
 * keys, so a heavy reader is never refused for how much they have read. Past 1000 distinct keys, or
 * 256 KiB of keys, discovery is `unavailable` with reason `limit`.
 */
export const readCoverageInputs: ReadCoverageInputs = async (scope) => {
  const { revision } = await readContextRevision(scope);
  const keys = await sql<{
    topicId: string;
    facetId: string;
    explanationUnitId: string;
  }>`select distinct topic_id as "topicId",facet_id as "facetId",explanation_unit_id as "explanationUnitId"
 from personal_context.coverage_supports where universe_id=${scope.authority.universeId}::uuid and privacy_epoch=${scope.authority.privacyEpoch}
 limit ${MAX_DISCOVERY_KEYS + 1}`.execute(transactionOf(scope));
  const probes = [...keys.rows].sort(
    (a, b) =>
      ordinal(a.topicId, b.topicId) ||
      ordinal(a.facetId, b.facetId) ||
      ordinal(a.explanationUnitId, b.explanationUnitId),
  );
  const overflow =
    probes.length > MAX_DISCOVERY_KEYS ||
    new TextEncoder().encode(JSON.stringify(probes)).byteLength > MAX_DISCOVERY_BYTES;
  return {
    revision,
    completeness: 'not_asserted',
    availability: overflow ? 'unavailable' : 'available',
    reason: overflow ? 'limit' : 'bounded',
    probes: overflow ? [] : probes,
  };
};
