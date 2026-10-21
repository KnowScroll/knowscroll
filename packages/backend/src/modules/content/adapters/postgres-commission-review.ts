import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { cutroomTransactionOf } from '../../../infrastructure/postgres/cutroom-scope.js';
import type { CutroomScopeTx } from '../../../reasoning/public.js';
import type {
  CommissionReviewStore,
  CommissionReviewDraft,
  CommissionReviewPacket,
  ReelCorpusManifest,
} from '../production/commission-review-ports.js';
import {
  checkReelCorpus,
  matchesHumanApproval,
  parseCommissionReviewPacket,
  reelFingerprint,
  prepareCommissionReview,
  CommissionReviewProposalSchema,
  sealCommissionReviewDraft,
  draftOfPacket,
} from '../production/commission-review.js';
const hash = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');
async function lockBusiness(scope: CutroomScopeTx, id: string) {
  return cutroomTransactionOf(scope)
    .selectFrom('content.reel_commissions')
    .selectAll()
    .where('world_id', '=', scope.authority.worldId)
    .where('business_run_id', '=', id)
    .forUpdate()
    .executeTakeFirst();
}
function sameBusiness(c: Awaited<ReturnType<typeof lockBusiness>>, p: CommissionReviewDraft, scope: CutroomScopeTx) {
  return (
    c &&
    c.attempt_id !== null &&
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
async function retained(scope: CutroomScopeTx) {
  return cutroomTransactionOf(scope)
    .selectFrom('content.cutroom_reviews as r')
    .leftJoin('content.reel_commissions as b', (j) =>
      j.onRef('b.world_id', '=', 'r.world_id').onRef('b.business_run_id', '=', 'r.business_run_id'),
    )
    .selectAll('r')
    .select([
      'b.generation as business_generation',
      'b.script_sha256 as business_script_sha256',
      'b.evidence_sha256 as business_evidence_sha256',
      'b.request_sha256 as business_request_sha256',
      'b.request_id as business_request_id',
      'b.take as business_take',
      'b.ceiling_cents as business_ceiling_cents',
      'b.package_sha256 as business_package_sha256',
      'b.command_sha256 as business_command_sha256',
      'b.policy_version as business_policy_version',
      'b.approval_ref as business_approval_ref',
      'b.attempt_id as business_attempt_id',
      sql<string | null>`to_char(r.revoked_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as('revoked_text'),
    ])
    .orderBy('r.world_id')
    .orderBy('r.business_run_id')
    .limit(1001)
    .forShare('r')
    .execute();
}
type RetainedRow = Awaited<ReturnType<typeof retained>>[number];
function packetOfRow(row: RetainedRow): CommissionReviewPacket | undefined {
  if (Buffer.byteLength(row.packet_utf8, 'utf8') > 100000) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(row.packet_utf8);
  } catch {
    return undefined;
  }
  const p = parseCommissionReviewPacket(value);
  if (
    !p ||
    row.world_id !== p.worldId ||
    row.business_run_id !== p.businessRunId ||
    row.review_sha256 !== p.reviewSha256 ||
    row.corpus_sha256 !== p.corpusSnapshotSha256 ||
    row.template_sha256 !== p.templateSha256 ||
    row.bridge_sha256 !== p.bridgeSha256 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(row.human_evidence_ref) ||
    (row.revoked_text !== null && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(row.revoked_text)) ||
    row.business_generation !== p.generation ||
    row.business_script_sha256 !== p.scriptSha256 ||
    row.business_evidence_sha256 !== p.evidenceSha256 ||
    row.business_request_sha256 !== p.requestSha256 ||
    row.business_request_id !== p.requestId ||
    row.business_take !== p.take ||
    row.business_ceiling_cents !== p.ceilingCents ||
    row.business_package_sha256 !== p.scriptSha256 ||
    row.business_policy_version !== 'cutroom-commission.v1' ||
    row.business_attempt_id === null
  )
    return undefined;
  return p;
}
/** Complete bounded metadata snapshot. Validate EVERY row BEFORE novelty filtering; no status/version skipping. */
async function snapshot(
  scope: CutroomScopeTx,
  draft: CommissionReviewDraft,
  manifests: readonly ReelCorpusManifest[],
  self?: { packet: CommissionReviewPacket; human: string },
): Promise<
  | { kind: 'clear'; sha: string }
  | { kind: 'refused'; code: 'corpus_unavailable' | 'repetition' | 'identity' | 'revoked' }
> {
  const trx = cutroomTransactionOf(scope);
  await sql`select pg_advisory_xact_lock(24031)`.execute(trx);
  if (manifests.length !== 1) return { kind: 'refused', code: 'corpus_unavailable' };
  const legacy = await trx
    .selectFrom('content.cutroom_corpus')
    .selectAll()
    .orderBy('source_namespace')
    .orderBy('generated_reel_id')
    .limit(1001)
    .execute();
  const records: unknown[] = [];
  for (const r of legacy) {
    try {
      const v: unknown = JSON.parse(r.record_utf8);
      if (!v || typeof v !== 'object' || Array.isArray(v)) return { kind: 'refused', code: 'corpus_unavailable' };
      const value = v as Record<string, unknown>;
      if (
        value['sourceNamespace'] !== r.source_namespace ||
        value['generatedReelId'] !== r.generated_reel_id ||
        value['originalTemplateSha256'] !== r.original_template_sha256 ||
        value['originalArgumentSha256'] !== r.original_argument_sha256 ||
        value['bridgeSha256'] !== r.bridge_sha256 ||
        hash(r.record_utf8) !== r.record_sha256
      )
        return { kind: 'refused', code: 'corpus_unavailable' };
      records.push(v);
    } catch {
      return { kind: 'refused', code: 'corpus_unavailable' };
    }
  }
  const legacyVerdict = checkReelCorpus(records, manifests[0]!, draft);
  if (legacyVerdict === 'corpus_unavailable') return { kind: 'refused', code: legacyVerdict };
  const rows = await retained(scope);
  if (rows.length > 1000 || rows.reduce((n, r) => n + Buffer.byteLength(r.packet_utf8, 'utf8'), 0) > 8 * 1024 * 1024)
    return { kind: 'refused', code: 'corpus_unavailable' };
  const valid: { row: RetainedRow; packet: CommissionReviewPacket }[] = [];
  for (const row of rows) {
    const packet = packetOfRow(row);
    if (!packet) return { kind: 'refused', code: 'corpus_unavailable' };
    valid.push({ row, packet });
  }
  const others: typeof valid = [];
  for (const v of valid) {
    if (v.row.world_id === draft.worldId && v.row.business_run_id === draft.businessRunId) {
      if (
        !self ||
        reelFingerprint(v.packet) !== reelFingerprint(self.packet) ||
        v.row.human_evidence_ref !== self.human
      )
        return { kind: 'refused', code: 'identity' };
      if (v.row.revoked_at !== null) return { kind: 'refused', code: 'revoked' };
    } else others.push(v);
  }
  if (
    legacyVerdict === 'repetition' ||
    others.some((v) => v.packet.templateSha256 === draft.templateSha256 || v.packet.bridgeSha256 === draft.bridgeSha256)
  )
    return { kind: 'refused', code: 'repetition' };
  const entries = others.map(({ row: r, packet: p }) => ({
    worldId: r.world_id,
    businessRunId: r.business_run_id,
    reviewSha256: p.reviewSha256,
    corpusSnapshotSha256: p.corpusSnapshotSha256,
    packetSha256: hash(r.packet_utf8),
    templateSha256: p.templateSha256,
    bridgeSha256: p.bridgeSha256,
    humanEvidenceRef: r.human_evidence_ref,
    revokedAt: r.revoked_text,
    businessGeneration: r.business_generation,
    scriptSha256: r.business_script_sha256,
    evidenceSha256: r.business_evidence_sha256,
    requestSha256: r.business_request_sha256,
    requestId: r.business_request_id,
    take: r.business_take,
    ceilingCents: r.business_ceiling_cents,
    packageSha256: r.business_package_sha256,
    commandSha256: r.business_command_sha256,
    policyVersion: r.business_policy_version,
    approvalRef: r.business_approval_ref,
    attemptId: r.business_attempt_id,
  }));
  return {
    kind: 'clear',
    sha: reelFingerprint({
      version: 'cutroom-corpus-snapshot.v1',
      legacyCompleteness: manifests[0],
      retainedV2: entries,
    }),
  };
}
async function own(scope: CutroomScopeTx, id: string) {
  return cutroomTransactionOf(scope)
    .selectFrom('content.cutroom_reviews')
    .selectAll()
    .where('world_id', '=', scope.authority.worldId)
    .where('business_run_id', '=', id)
    .executeTakeFirst();
}
function parseOwn(row: Awaited<ReturnType<typeof own>>) {
  if (!row) return undefined;
  try {
    return parseCommissionReviewPacket(JSON.parse(row.packet_utf8) as unknown);
  } catch {
    return undefined;
  }
}
export const postgresCommissionReview: CommissionReviewStore = {
  async prepare(scope, input, manifests) {
    cutroomTransactionOf(scope);
    const p = CommissionReviewProposalSchema.safeParse(input);
    if (!p.success) return { kind: 'refused', code: 'invalid' };
    const v = p.data;
    if (
      !scope.enabled ||
      scope.mode !== 'admit' ||
      v.worldId !== scope.authority.worldId ||
      v.generation !== scope.authority.generation
    )
      return { kind: 'refused', code: 'identity' };
    const business = await lockBusiness(scope, v.businessRunId);
    // Existing business MUST be checked before compilation. No maintenance bootstrap/reconstruction.
    if (business) {
      const old = await own(scope, v.businessRunId),
        packet = parseOwn(old);
      if (
        !old ||
        !packet ||
        !sameBusiness(business, packet, scope) ||
        reelFingerprint(v) !==
          reelFingerprint({
            businessRunId: packet.businessRunId,
            worldId: packet.worldId,
            generation: packet.generation,
            take: packet.take,
            ceilingCents: packet.ceilingCents,
            rightsReviewRef: packet.rightsReviewRef,
            framingReviewRef: packet.framingReviewRef,
            targetReviewRef: packet.targetReviewRef,
            script: packet.script,
          })
      )
        return { kind: 'refused', code: 'identity' };
      const s = await snapshot(scope, draftOfPacket(packet), manifests, { packet, human: old.human_evidence_ref });
      if (s.kind !== 'clear') return { kind: 'refused', code: s.code === 'revoked' ? 'identity' : s.code };
      return s.sha === packet.corpusSnapshotSha256
        ? { kind: 'prepared', packet }
        : { kind: 'refused', code: 'stale_snapshot' };
    }
    const d = prepareCommissionReview(v);
    if (d.kind !== 'draft') return d;
    const s = await snapshot(scope, d.draft, manifests);
    if (s.kind !== 'clear') return { kind: 'refused', code: s.code === 'revoked' ? 'identity' : s.code };
    return { kind: 'prepared', packet: sealCommissionReviewDraft(d.draft, s.sha) };
  },
  async gate(scope, input, manifests, humanEvidenceRef) {
    const trx = cutroomTransactionOf(scope),
      packet = parseCommissionReviewPacket(input);
    if (!packet) return { kind: 'refused', code: 'invalid' };
    const business = await lockBusiness(scope, packet.businessRunId);
    if (!sameBusiness(business, packet, scope)) return { kind: 'refused', code: 'identity' };
    const old = await own(scope, packet.businessRunId),
      oldPacket = parseOwn(old);
    if (
      old &&
      (!oldPacket ||
        reelFingerprint(oldPacket) !== reelFingerprint(packet) ||
        old.human_evidence_ref !== humanEvidenceRef)
    )
      return { kind: 'refused', code: 'identity' };
    const s = await snapshot(
      scope,
      draftOfPacket(packet),
      manifests,
      old ? { packet, human: humanEvidenceRef } : undefined,
    );
    if (s.kind !== 'clear') return s;
    if (s.sha !== packet.corpusSnapshotSha256) return { kind: 'refused', code: 'stale_snapshot' };
    if (!old)
      await trx
        .insertInto('content.cutroom_reviews')
        .values({
          world_id: scope.authority.worldId,
          business_run_id: packet.businessRunId,
          packet_utf8: JSON.stringify(packet),
          review_sha256: packet.reviewSha256,
          corpus_sha256: s.sha,
          template_sha256: packet.templateSha256,
          bridge_sha256: packet.bridgeSha256,
          human_evidence_ref: humanEvidenceRef,
        })
        .execute();
    return { kind: 'reviewed', binding: { reviewSha256: packet.reviewSha256, corpusSha256: s.sha, humanEvidenceRef } };
  },
  async recheck(scope, id, approvals, manifests) {
    cutroomTransactionOf(scope);
    const business = await lockBusiness(scope, id),
      old = await own(scope, id),
      packet = parseOwn(old);
    if (!old || !packet || !sameBusiness(business, packet, scope) || old.revoked_at !== null) return undefined;
    if (
      approvals.filter((a) => matchesHumanApproval(a, packet) && a.humanEvidenceRef === old.human_evidence_ref)
        .length !== 1
    )
      return undefined;
    const s = await snapshot(scope, draftOfPacket(packet), manifests, { packet, human: old.human_evidence_ref });
    return s.kind === 'clear' && s.sha === packet.corpusSnapshotSha256
      ? { reviewSha256: packet.reviewSha256, corpusSha256: s.sha, humanEvidenceRef: old.human_evidence_ref }
      : undefined;
  },
};
