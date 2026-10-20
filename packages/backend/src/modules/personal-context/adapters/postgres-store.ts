import { sql } from 'kysely';
import { requestHash } from '../../../infrastructure/receipts/index.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { CONTEXT_POLICY, ContributionSchema, supportChanges, type Contribution } from '../domain/context.js';
import type { ApplyProjectedEncounter, ContextPorts } from '../application/ports.js';

export const applyProjectedEncounter: ApplyProjectedEncounter = async (scope, input) => {
  const next = ContributionSchema.parse(input);
  const db = transactionOf(scope),
    u = scope.authority.universeId,
    e = scope.authority.privacyEpoch;
  const digest = requestHash(CONTEXT_POLICY, next);
  const old = await sql<{
    input_sha256: string;
    payload: unknown;
  }>`select input_sha256,payload from personal_context.contributions where universe_id=${u}::uuid and privacy_epoch=${e} and exposure_id=${next.exposureId}::uuid`.execute(
    db,
  );
  if (old.rows[0]?.input_sha256 === digest) return false;
  const previous = old.rows[0] ? ContributionSchema.parse(old.rows[0].payload) : undefined;
  for (const change of supportChanges(previous, next)) {
    const row = await sql<{
      reference_count: number;
    }>`select reference_count from personal_context.supports where universe_id=${u}::uuid and privacy_epoch=${e} and topic_id=${change.topicId} and kind=${change.kind} and support_key=${change.key}`.execute(
      db,
    );
    const before = row.rows[0]?.reference_count ?? 0;
    const after = before + change.delta;
    if (after < 0) throw new Error('PERSONAL_CONTEXT_SUPPORT_UNDERFLOW');
    if (after === 0) {
      await sql`delete from personal_context.supports where universe_id=${u}::uuid and privacy_epoch=${e} and topic_id=${change.topicId} and kind=${change.kind} and support_key=${change.key}`.execute(
        db,
      );
    } else {
      await sql`insert into personal_context.supports(universe_id,privacy_epoch,topic_id,kind,support_key,reference_count) values(${u}::uuid,${e},${change.topicId},${change.kind},${change.key},${after}) on conflict(universe_id,privacy_epoch,topic_id,kind,support_key) do update set reference_count=excluded.reference_count`.execute(
        db,
      );
    }
    const distinctDelta = Number(after > 0) - Number(before > 0);
    if (distinctDelta !== 0) {
      const units = change.kind === 'unit' ? distinctDelta : 0,
        facets = change.kind === 'facet' ? distinctDelta : 0;
      await sql`insert into personal_context.topics(universe_id,privacy_epoch,topic_id,qualified_units,covered_facets) values(${u}::uuid,${e},${change.topicId},0,0) on conflict(universe_id,privacy_epoch,topic_id) do nothing`.execute(
        db,
      );
      await sql`update personal_context.topics set qualified_units=qualified_units+${units},covered_facets=covered_facets+${facets} where universe_id=${u}::uuid and privacy_epoch=${e} and topic_id=${change.topicId}`.execute(
        db,
      );
    }
  }
  await sql`insert into personal_context.contributions(universe_id,privacy_epoch,exposure_id,explanation_unit_id,qualified,input_sha256,payload_version,payload) values(${u}::uuid,${e},${next.exposureId}::uuid,${next.explanationUnitId},${next.qualified},${digest},${next.version},${JSON.stringify(next)}::jsonb) on conflict(universe_id,exposure_id) do update set privacy_epoch=excluded.privacy_epoch,explanation_unit_id=excluded.explanation_unit_id,qualified=excluded.qualified,input_sha256=excluded.input_sha256,payload_version=excluded.payload_version,payload=excluded.payload,projected_at=now()`.execute(
    db,
  );
  await advanceContextState(scope);
  return true;
};
export const readContextRevision: ContextPorts['readRevision'] = async (scope) => {
  const r = await sql<{
    revision: number;
    projected_scope_revision: number;
  }>`select revision,projected_scope_revision from personal_context.state where universe_id=${scope.authority.universeId}::uuid and privacy_epoch=${scope.authority.privacyEpoch}`.execute(
    transactionOf(scope),
  );
  return { revision: r.rows[0]?.revision ?? 0, projected: r.rows[0]?.projected_scope_revision ?? 0 };
};
export const readStructure: ContextPorts['readStructure'] = async (scope, q) => {
  const db = transactionOf(scope),
    u = scope.authority.universeId,
    e = scope.authority.privacyEpoch;
  const topics = q.topicIds.length
    ? await sql<{
        topic_id: string;
        qualified_units: number;
        covered_facets: number;
      }>`select topic_id,qualified_units,covered_facets from personal_context.topics where universe_id=${u}::uuid and privacy_epoch=${e} and topic_id=any(${q.topicIds}::text[]) limit 100`.execute(
        db,
      )
    : { rows: [] };
  const units = q.candidates.map((c) => c.explanationUnitId);
  // Exact candidate-unit probes; all returned support topics are restricted to requested topics.
  const rows =
    units.length && q.topicIds.length
      ? await sql<{
          topic_id: string;
          support_key: string;
          kind: 'unit' | 'facet';
        }>`select topic_id,support_key,kind from personal_context.supports where universe_id=${u}::uuid and privacy_epoch=${e} and topic_id=any(${q.topicIds}::text[]) and kind='unit' and support_key=any(${units}::text[]) limit 10000`.execute(
          db,
        )
      : { rows: [] };
  // One indexed current source per exact candidate, in one bounded query rather than N+1.
  const proofRows = units.length
    ? await sql<{
        payload: unknown;
      }>`select p.payload from unnest(${units}::text[]) as candidate(unit) cross join lateral (select payload from personal_context.contributions where universe_id=${u}::uuid and privacy_epoch=${e} and explanation_unit_id=candidate.unit and qualified order by exposure_id limit 1) p limit 100`.execute(
        db,
      )
    : { rows: [] };
  const proofs: Contribution[] = proofRows.rows.map((r) => ContributionSchema.parse(r.payload));
  return {
    topics: topics.rows.map((t) => ({
      topicId: t.topic_id,
      qualifiedExplanationUnits: t.qualified_units,
      coveredFacets: t.covered_facets,
    })),
    qualified: q.candidates.map((c) => ({
      explanationUnitId: c.explanationUnitId,
      topicIds: rows.rows.filter((r) => r.support_key === c.explanationUnitId).map((r) => r.topic_id),
      // No trusted facet-coverage mapper exists yet. Metadata tags are routing-only.
      facets: c.facets.map((facetId) => ({ facetId, topicIds: [] })),
    })),
    supportingEvidence: proofs,
  };
};

/** One PC revision for a changed combined projection; the producer owns the scope hint. */
export async function advanceContextState(scope: Parameters<ApplyProjectedEncounter>[0]) {
  await sql`insert into personal_context.state(universe_id,privacy_epoch,revision,projected_scope_revision,policy_version) values(${scope.authority.universeId}::uuid,${scope.authority.privacyEpoch},1,${scope.revisionAtEntry + 1},${CONTEXT_POLICY}) on conflict(universe_id,privacy_epoch) do update set revision=personal_context.state.revision+1,projected_scope_revision=excluded.projected_scope_revision,policy_version=excluded.policy_version`.execute(
    transactionOf(scope),
  );
}
