import { sql } from 'kysely';
import { cutroomTransactionOf } from '../../../infrastructure/postgres/cutroom-scope.js';
import type { CutroomScopeTx } from '../../../reasoning/public.js';
import type {
  CommissionReviewStore,
  CommissionReviewPacket,
  CommissionReviewVerdict,
  ReelCorpusManifest,
} from '../production/commission-review-ports.js';
import {
  checkReelCorpus,
  matchesHumanApproval,
  parseCommissionReviewPacket,
  reelFingerprint,
} from '../production/commission-review.js';
async function lockBusiness(scope: CutroomScopeTx, id: string) {
  return cutroomTransactionOf(scope)
    .selectFrom('content.reel_commissions')
    .selectAll()
    .where('world_id', '=', scope.authority.worldId)
    .where('business_run_id', '=', id)
    .forUpdate()
    .executeTakeFirst();
}
/** Root/business already precede the one cross-world corpus serialization lock. No private/personal root or external I/O. */
async function corpus(
  scope: CutroomScopeTx,
  packet: CommissionReviewPacket,
  manifests: readonly ReelCorpusManifest[],
): Promise<{ kind: 'clear'; sha: string } | { kind: 'refused'; code: 'corpus_unavailable' | 'repetition' }> {
  const trx = cutroomTransactionOf(scope);
  await sql`select pg_advisory_xact_lock(24031)`.execute(trx);
  if (manifests.length !== 1) return { kind: 'refused', code: 'corpus_unavailable' };
  const rows = await trx
    .selectFrom('content.cutroom_corpus')
    .selectAll()
    .orderBy('source_namespace')
    .orderBy('generated_reel_id')
    .limit(1001)
    .execute();
  const records: unknown[] = [];
  for (const row of rows) {
    try {
      const value: unknown = JSON.parse(row.record_utf8);
      if (!value || typeof value !== 'object' || Array.isArray(value))
        return { kind: 'refused', code: 'corpus_unavailable' };
      const v = value as Record<string, unknown>;
      if (
        v['sourceNamespace'] !== row.source_namespace ||
        v['generatedReelId'] !== row.generated_reel_id ||
        v['originalTemplateSha256'] !== row.original_template_sha256 ||
        v['originalArgumentSha256'] !== row.original_argument_sha256 ||
        v['bridgeSha256'] !== row.bridge_sha256
      )
        return { kind: 'refused', code: 'corpus_unavailable' };
      records.push(value);
    } catch {
      return { kind: 'refused', code: 'corpus_unavailable' };
    }
  }
  const verdict = checkReelCorpus(records, manifests[0]!, packet);
  if (verdict !== 'clear') return { kind: 'refused', code: verdict };
  // Include every other admitted candidate, even revoked ones; no take replacement or corpus reset.
  const duplicate =
    await sql`select 1 from content.cutroom_reviews where not(world_id=${scope.authority.worldId} and business_run_id=${packet.businessRunId}::uuid) and (template_sha256=${packet.templateSha256} or bridge_sha256=${packet.bridgeSha256}) limit 1`.execute(
      trx,
    );
  return duplicate.rows.length
    ? { kind: 'refused', code: 'repetition' }
    : { kind: 'clear', sha: reelFingerprint(manifests[0]) };
}
function sameBusiness(c: Awaited<ReturnType<typeof lockBusiness>>, p: CommissionReviewPacket, scope: CutroomScopeTx) {
  return (
    c &&
    scope.enabled &&
    scope.mode === 'admit' &&
    p.worldId === scope.authority.worldId &&
    p.generation === scope.authority.generation &&
    c.generation === p.generation &&
    c.script_sha256 === p.scriptSha256 &&
    c.evidence_sha256 === p.evidenceSha256 &&
    c.package_utf8 === JSON.stringify(p.script) &&
    c.request_sha256 === p.requestSha256 &&
    c.request_id === p.requestId &&
    c.take === p.take &&
    c.ceiling_cents === p.ceilingCents
  );
}
export const postgresCommissionReview: CommissionReviewStore = {
  async gate(scope, input, manifests, humanEvidenceRef): Promise<CommissionReviewVerdict> {
    const trx = cutroomTransactionOf(scope),
      packet = parseCommissionReviewPacket(input);
    if (!packet) return { kind: 'refused', code: 'invalid' };
    const business = await lockBusiness(scope, packet.businessRunId);
    if (!sameBusiness(business, packet, scope)) return { kind: 'refused', code: 'identity' };
    const gate = await corpus(scope, packet, manifests);
    if (gate.kind !== 'clear') return gate;
    const old = await trx
      .selectFrom('content.cutroom_reviews')
      .selectAll()
      .where('world_id', '=', scope.authority.worldId)
      .where('business_run_id', '=', packet.businessRunId)
      .forUpdate()
      .executeTakeFirst();
    if (
      old &&
      (old.revoked_at !== null ||
        old.review_sha256 !== packet.reviewSha256 ||
        old.corpus_sha256 !== gate.sha ||
        old.human_evidence_ref !== humanEvidenceRef ||
        old.packet_utf8 !== JSON.stringify(packet))
    )
      return { kind: 'refused', code: old.revoked_at !== null ? 'revoked' : 'identity' };
    if (!old)
      await trx
        .insertInto('content.cutroom_reviews')
        .values({
          world_id: scope.authority.worldId,
          business_run_id: packet.businessRunId,
          packet_utf8: JSON.stringify(packet),
          review_sha256: packet.reviewSha256,
          corpus_sha256: gate.sha,
          template_sha256: packet.templateSha256,
          bridge_sha256: packet.bridgeSha256,
          human_evidence_ref: humanEvidenceRef,
        })
        .execute();
    return {
      kind: 'reviewed',
      binding: { reviewSha256: packet.reviewSha256, corpusSha256: gate.sha, humanEvidenceRef },
    };
  },
  async recheck(scope, businessRunId, approvals, manifests) {
    const trx = cutroomTransactionOf(scope),
      business = await lockBusiness(scope, businessRunId);
    const old = await trx
      .selectFrom('content.cutroom_reviews')
      .selectAll()
      .where('world_id', '=', scope.authority.worldId)
      .where('business_run_id', '=', businessRunId)
      .forUpdate()
      .executeTakeFirst();
    if (!old || old.revoked_at !== null) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(old.packet_utf8);
    } catch {
      return undefined;
    }
    const packet = parseCommissionReviewPacket(parsed);
    if (
      !packet ||
      !sameBusiness(business, packet, scope) ||
      old.review_sha256 !== packet.reviewSha256 ||
      old.template_sha256 !== packet.templateSha256 ||
      old.bridge_sha256 !== packet.bridgeSha256
    )
      return undefined;
    const matching = approvals.filter(
      (a) => matchesHumanApproval(a, packet) && a.humanEvidenceRef === old.human_evidence_ref,
    );
    if (matching.length !== 1) return undefined;
    const gate = await corpus(scope, packet, manifests);
    if (gate.kind !== 'clear' || gate.sha !== old.corpus_sha256) return undefined;
    return { reviewSha256: packet.reviewSha256, corpusSha256: gate.sha, humanEvidenceRef: old.human_evidence_ref };
  },
};
