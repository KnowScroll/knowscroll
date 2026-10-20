import { sql } from 'kysely';
import { canonicalJson, canonicalSha256, utf8ByteLength } from '@knowscroll/scroll-model';
import { ObservedCoverageSchema, type ObservedCoverage } from '../../evidence/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import type { CoverageHead } from '../../content/public.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { coverageSupports, coverageSupportKey } from '../domain/coverage.js';
import type { StoredCoverage, CoverageDependencies } from '../application/coverage-ports.js';

export const coverageDigest = (activityId: string, certificate: ObservedCoverage) =>
  canonicalSha256({ activityId, certificate });
export async function readStoredCoverage(scope: PersonalScopeTx, id: string): Promise<StoredCoverage | undefined> {
  const r = await sql<{
    activity_id: string;
    input_sha256: string;
    payload: unknown;
  }>`select activity_id,input_sha256,payload from personal_context.coverage_contributions where universe_id=${scope.authority.universeId}::uuid and privacy_epoch=${scope.authority.privacyEpoch} and exposure_id=${id}::uuid`.execute(
    transactionOf(scope),
  );
  const row = r.rows[0];
  if (!row) return undefined;
  const certificate = ObservedCoverageSchema.parse(row.payload);
  if (coverageDigest(row.activity_id, certificate) !== row.input_sha256 || certificate.exposureId !== id)
    throw new Error('PERSONAL_COVERAGE_STORED_INVALID');
  return { activityId: row.activity_id, digest: row.input_sha256, certificate };
}
export function certificateMatchesHead(c: ObservedCoverage, head: CoverageHead): boolean {
  if (!c.mapping || head.status !== 'active') return false;
  const { version: _version, bindings, ...identity } = head.mapping;
  return (
    canonicalSha256(c.mapping) === canonicalSha256({ authority: head.authority, ...identity }) &&
    c.factsSha256 === identity.readingFactsSha256 &&
    c.bindings.every((b) => bindings.some((x) => canonicalSha256(x) === canonicalSha256(b)))
  );
}
/** Positive apply holds shared Content authority through commit and repeats Evidence after waits. */
export async function fenceCoverage(scope: PersonalScopeTx, c: ObservedCoverage, p: CoverageDependencies) {
  if (c.availability !== 'available') return;
  if (!c.mapping || !(await p.lockAuthorities(scope, [c.mapping.authority])))
    throw new Error('PERSONAL_COVERAGE_AUTHORITY_CHANGED');
  const current = await p.readMapping(scope, { assetId: c.assetId, assetRevision: c.assetRevision });
  if (
    current.kind !== 'mapped' ||
    !certificateMatchesHead(c, current.head) ||
    !(await p.checkEvidence(scope, [c])).includes(c.exposureId)
  )
    throw new Error('PERSONAL_COVERAGE_AUTHORITY_CHANGED');
}
export async function applyCoverage(
  scope: PersonalScopeTx,
  activityId: string,
  input: ObservedCoverage,
  p: CoverageDependencies,
): Promise<boolean> {
  const c = ObservedCoverageSchema.parse(input);
  if (c.universeId !== scope.authority.universeId || c.privacyEpoch !== scope.authority.privacyEpoch)
    throw new Error('PERSONAL_COVERAGE_SCOPE_INVALID');
  if (utf8ByteLength(canonicalJson(c)) > 16384) throw new Error('PERSONAL_COVERAGE_LIMIT');
  await fenceCoverage(scope, c, p);
  const previous = await readStoredCoverage(scope, c.exposureId),
    digest = coverageDigest(activityId, c);
  if (previous?.digest === digest) return false;
  const old = new Map((previous ? coverageSupports(previous.certificate) : []).map((s) => [coverageSupportKey(s), s]));
  const next = new Map(coverageSupports(c).map((s) => [coverageSupportKey(s), s]));
  const changes = [
    ...[...old].filter(([k]) => !next.has(k)).map(([, s]) => ({ ...s, delta: -1 })),
    ...[...next].filter(([k]) => !old.has(k)).map(([, s]) => ({ ...s, delta: 1 })),
  ];
  const db = transactionOf(scope),
    u = scope.authority.universeId,
    e = scope.authority.privacyEpoch;
  for (const s of changes) {
    const r = await sql<{
      reference_count: number;
    }>`select reference_count from personal_context.coverage_supports where universe_id=${u}::uuid and privacy_epoch=${e} and topic_id=${s.topicId} and facet_id=${s.facetId} and meaning_sha256=${s.meaningSha256} and explanation_unit_id=${s.explanationUnitId} and truth_sha256=${s.truthSha256}`.execute(
      db,
    );
    const count = (r.rows[0]?.reference_count ?? 0) + s.delta;
    if (count < 0) throw new Error('PERSONAL_COVERAGE_SUPPORT_UNDERFLOW');
    if (!count)
      await sql`delete from personal_context.coverage_supports where universe_id=${u}::uuid and privacy_epoch=${e} and topic_id=${s.topicId} and facet_id=${s.facetId} and meaning_sha256=${s.meaningSha256} and explanation_unit_id=${s.explanationUnitId} and truth_sha256=${s.truthSha256}`.execute(
        db,
      );
    else
      await sql`insert into personal_context.coverage_supports(universe_id,privacy_epoch,topic_id,facet_id,meaning_sha256,explanation_unit_id,truth_sha256,reference_count) values(${u}::uuid,${e},${s.topicId},${s.facetId},${s.meaningSha256},${s.explanationUnitId},${s.truthSha256},${count}) on conflict(universe_id,privacy_epoch,topic_id,facet_id,meaning_sha256,explanation_unit_id,truth_sha256) do update set reference_count=excluded.reference_count`.execute(
        db,
      );
  }
  await sql`insert into personal_context.coverage_contributions(universe_id,privacy_epoch,exposure_id,activity_id,input_sha256,payload) values(${u}::uuid,${e},${c.exposureId}::uuid,${activityId}::uuid,${digest},${JSON.stringify(c)}::jsonb) on conflict(universe_id,exposure_id) do update set privacy_epoch=excluded.privacy_epoch,activity_id=excluded.activity_id,input_sha256=excluded.input_sha256,payload=excluded.payload`.execute(
    db,
  );
  await sql`delete from personal_context.coverage_references where universe_id=${u}::uuid and exposure_id=${c.exposureId}::uuid`.execute(
    db,
  );
  for (const s of next.values())
    await sql`insert into personal_context.coverage_references(universe_id,privacy_epoch,exposure_id,topic_id,facet_id,meaning_sha256,explanation_unit_id,truth_sha256) values(${u}::uuid,${e},${c.exposureId}::uuid,${s.topicId},${s.facetId},${s.meaningSha256},${s.explanationUnitId},${s.truthSha256})`.execute(
      db,
    );
  return true;
}
