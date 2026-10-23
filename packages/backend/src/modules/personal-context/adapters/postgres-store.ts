import { sql } from 'kysely';
import { requestHash } from '../../../infrastructure/receipts/index.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { fencePersonalRecording } from '../../../infrastructure/postgres/recording-scope.js';
import {
  CONTEXT_POLICY,
  ContributionSchema,
  ContextQuerySchema,
  RecordingContributionEnvelopeSchema,
  supportChanges,
  type Contribution,
} from '../domain/context.js';
import type { ApplyProjectedEncounter, ContextPorts } from '../application/ports.js';

export const applyProjectedEncounter: ApplyProjectedEncounter = async (scope, input) => {
  const gate = await fencePersonalRecording(scope, undefined);
  if (gate.kind !== 'recording') throw new Error('PERSONAL_CONTEXT_RECORDING_REQUIRED');
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
  const converted = await db
    .selectFrom('personal_context.recording_exposure_contributions')
    .select('exposure_id')
    .where('universe_id', '=', u)
    .where('exposure_id', '=', next.exposureId)
    .executeTakeFirst();
  if (converted) throw new Error('PERSONAL_CONTEXT_RECORDING_REQUIRED');
  if (old.rows[0]?.input_sha256 === digest) return false;
  const previous = old.rows[0] ? ContributionSchema.parse(old.rows[0].payload) : undefined;
  await replaceStructuralSupports(scope, previous, next);
  await sql`insert into personal_context.contributions(universe_id,privacy_epoch,exposure_id,explanation_unit_id,qualified,input_sha256,payload_version,payload) values(${u}::uuid,${e},${next.exposureId}::uuid,${next.explanationUnitId},${next.qualified},${digest},${next.version},${JSON.stringify(next)}::jsonb) on conflict(universe_id,exposure_id) do update set privacy_epoch=excluded.privacy_epoch,explanation_unit_id=excluded.explanation_unit_id,qualified=excluded.qualified,input_sha256=excluded.input_sha256,payload_version=excluded.payload_version,payload=excluded.payload,projected_at=now()`.execute(
    db,
  );
  await advanceContextState(scope);
  return true;
};
/** One effective exposure/key reference, shared by legacy and genuine recording writers. */
export async function replaceStructuralSupports(
  scope: Parameters<ApplyProjectedEncounter>[0],
  previous: Contribution | undefined,
  next: Contribution,
) {
  const db = transactionOf(scope),
    u = scope.authority.universeId,
    e = scope.authority.privacyEpoch;
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
}
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
  ContextQuerySchema.parse(q);
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
  // Fixed candidate budgets precede shadow resolution. Never anti-join arbitrary legacy
  // history to fill a page after an exposure has converted to the effective recording cache.
  const legacyProofs = units.length
    ? await sql<{ exposure_id: string; payload: unknown }>`
    select p.exposure_id,p.payload from unnest(${units}::text[]) candidate(unit)
    cross join lateral(select exposure_id,payload from personal_context.contributions
      where universe_id=${u}::uuid and privacy_epoch=${e} and explanation_unit_id=candidate.unit and qualified
      order by exposure_id limit 1001) p limit 1001`.execute(db)
    : { rows: [] };
  const effectiveProofs = units.length
    ? await sql<{ exposure_id: string; payload: unknown }>`
    select p.exposure_id,p.payload from unnest(${units}::text[]) candidate(unit)
    cross join lateral(select exposure_id,payload from personal_context.recording_exposure_contributions
      where universe_id=${u}::uuid and privacy_epoch=${e} and explanation_unit_id=candidate.unit and qualified
      order by exposure_id limit 1001) p limit 1001`.execute(db)
    : { rows: [] };
  const overflow =
    legacyProofs.rows.length > 1000 ||
    effectiveProofs.rows.length > 1000 ||
    legacyProofs.rows.length + effectiveProofs.rows.length > 1000;
  const proofs: Contribution[] = [];
  const certified = new Set<string>();
  if (!overflow) {
    const ids = legacyProofs.rows.map((r) => r.exposure_id);
    const shadow = ids.length
      ? await db
          .selectFrom('personal_context.recording_exposure_contributions')
          .select('exposure_id')
          .where('universe_id', '=', u)
          .where('privacy_epoch', '=', e)
          .where('exposure_id', 'in', ids)
          .limit(1000)
          .execute()
      : [];
    const shadowed = new Set(shadow.map((r) => r.exposure_id));
    const candidates = [
      ...effectiveProofs.rows.map((r) => RecordingContributionEnvelopeSchema.parse(r.payload).contribution),
      ...legacyProofs.rows.filter((r) => !shadowed.has(r.exposure_id)).map((r) => ContributionSchema.parse(r.payload)),
    ];
    const selected = new Set<string>();
    for (const c of candidates)
      if (c?.qualified) {
        for (const t of c.topics)
          if (t.role !== 'incidental') certified.add(JSON.stringify([c.explanationUnitId, t.topicId]));
        if (!selected.has(c.explanationUnitId)) {
          selected.add(c.explanationUnitId);
          proofs.push(c);
        }
      }
  }
  const unresolved = rows.rows.some((r) => !certified.has(JSON.stringify([r.support_key, r.topic_id])));
  const unavailable = overflow || unresolved;
  return {
    proofAvailability: unavailable ? 'unavailable' : 'available',
    proofReason: overflow ? 'limit' : unresolved ? 'unresolved' : 'bounded',
    topics: topics.rows.map((t) => ({
      topicId: t.topic_id,
      qualifiedExplanationUnits: t.qualified_units,
      coveredFacets: t.covered_facets,
    })),
    qualified: q.candidates.map((c) => ({
      explanationUnitId: c.explanationUnitId,
      topicIds: unavailable
        ? []
        : rows.rows
            .filter(
              (r) =>
                r.support_key === c.explanationUnitId &&
                certified.has(JSON.stringify([c.explanationUnitId, r.topic_id])),
            )
            .map((r) => r.topic_id),
      // No trusted facet-coverage mapper exists yet. Metadata tags are routing-only.
      facets: c.facets.map((facetId) => ({ facetId, topicIds: [] })),
    })),
    supportingEvidence: unavailable ? [] : proofs,
  };
};

/** One PC revision for a changed combined projection; the producer owns the scope hint. */
export async function advanceContextState(scope: Parameters<ApplyProjectedEncounter>[0]) {
  await sql`insert into personal_context.state(universe_id,privacy_epoch,revision,projected_scope_revision,policy_version) values(${scope.authority.universeId}::uuid,${scope.authority.privacyEpoch},1,${scope.revisionAtEntry + 1},${CONTEXT_POLICY}) on conflict(universe_id,privacy_epoch) do update set revision=personal_context.state.revision+1,projected_scope_revision=excluded.projected_scope_revision,policy_version=excluded.policy_version`.execute(
    transactionOf(scope),
  );
}
