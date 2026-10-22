import { uuidv7 } from '../../../infrastructure/ids/index.js';
import { sql, type Kysely } from 'kysely';
import type { PgBoss } from 'pg-boss';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { withTransaction } from '../../../infrastructure/postgres/personal-scope.js';
import {
  cutroomReceiveTransactionOf,
  makeWithCutroomReceiveScope,
} from '../../../infrastructure/postgres/cutroom-receive-scope.js';
import { makeEnqueueCutroomReceive } from '../../../infrastructure/jobs/enqueue-cutroom-receive.js';
import { parseReceiveEnvelope, receiveSha256 } from '../production/commission-receive.js';
import { ReceiveRecoveryWorkSchema } from '../production/commission-receive-contracts.js';
import type { CommissionReceiveBinding } from '../production/commission-receive-contracts.js';
import type { ReceiveRecord, ReceiveScopeTx, ReceiveStore } from '../production/commission-receive-ports.js';

interface Row {
  payload_utf8: string;
  payload_sha256: string;
  state: 'pending' | 'admitted' | 'expired';
  lease_id: string | null;
  receipt_id: string | null;
  asset_id: string | null;
  asset_revision: number | null;
  receipt_sha256: string | null;
}
function recordOf(row: Row): ReceiveRecord {
  const parsed = parseReceiveEnvelope({ payloadUtf8: row.payload_utf8, payloadSha256: row.payload_sha256 });
  if (!parsed) throw new Error('CUTROOM_RECEIVE_STORED_IDENTITY');
  return {
    ...parsed.envelope,
    payload: parsed.payload,
    state: row.state,
    ...(row.lease_id ? { leaseId: row.lease_id } : {}),
    ...(row.state === 'admitted' && row.receipt_id && row.asset_id && row.asset_revision && row.receipt_sha256
      ? {
          receipt: {
            receiptId: row.receipt_id,
            handoffId: parsed.payload.handoffId,
            assetId: row.asset_id,
            assetRevision: row.asset_revision,
            receiptSha256: row.receipt_sha256,
          },
        }
      : {}),
  };
}
/** All writes use the separate receiving root. No financial/attempt table is touched. */
export function postgresCommissionReceive(
  db: Kysely<Database>,
  boss: PgBoss,
  options: {
    readonly enabled?: boolean;
    readonly worldId: 'dev' | 'stage';
    readonly generation: number;
    readonly fixture?: boolean;
  },
): ReceiveStore {
  const enqueue = makeEnqueueCutroomReceive(boss),
    world = options.worldId;
  const authority = { worldId: world, generation: options.generation };
  const withScope = makeWithCutroomReceiveScope<ReceiveScopeTx>(db, { enabled: options.enabled, lockTimeoutMs: 250 });
  async function load(scope: ReceiveScopeTx, id: string, lease: boolean) {
    const trx = cutroomReceiveTransactionOf(scope);
    await sql`select handoff_id from content.cutroom_receive_receipts where handoff_id=${id}::uuid and world_id=${scope.authority.worldId} for update`.execute(
      trx,
    );
    if (lease) {
      await sql`update content.cutroom_receive_receipts set state='expired',lease_id=null,lease_until=null where handoff_id=${id}::uuid and world_id=${world} and state='pending' and hard_deadline<=clock_timestamp()`.execute(
        trx,
      );
      const updated =
        await sql`update content.cutroom_receive_receipts set lease_id=${uuidv7()}::uuid,lease_until=clock_timestamp()+interval '120 seconds',deliveries=deliveries+1,next_at=clock_timestamp()+interval '15 minutes'
        where handoff_id=${id}::uuid and world_id=${world} and state='pending' and hard_deadline>clock_timestamp() and deliveries<2880 and (lease_until is null or lease_until<=clock_timestamp()) returning handoff_id`.execute(
          trx,
        );
      if (!updated.rows.length) {
        const old = (
          await sql<Row>`select * from content.cutroom_receive_receipts where handoff_id=${id}::uuid and world_id=${world} and state='admitted'`.execute(
            trx,
          )
        ).rows[0];
        return old ? recordOf(old) : undefined;
      }
    }
    const row = (
      await sql<Row>`select * from content.cutroom_receive_receipts where handoff_id=${id}::uuid and world_id=${world}`.execute(
        trx,
      )
    ).rows[0];
    return row ? recordOf(row) : undefined;
  }
  return {
    async stage(scope, envelope, payload, binding) {
      const trx = cutroomReceiveTransactionOf(scope);
      if (
        !scope.enabled ||
        scope.mode !== 'admit' ||
        scope.authority.worldId !== world ||
        payload.targetWorld !== world ||
        binding.targetWorld !== world ||
        binding.generation !== scope.authority.generation ||
        binding.handoffId !== payload.handoffId ||
        binding.payloadSha256 !== envelope.payloadSha256
      )
        return;
      if (payload.document.fixture) {
        const name = (await sql<{ name: string }>`select current_database() name`.execute(trx)).rows[0]?.name;
        if (options.fixture !== true || !name || !/^(ks_it_|knowscroll_fixture_)/.test(name)) return;
      }
      await sql`select pg_advisory_xact_lock(hashtextextended(${`content.receive:${world}:${payload.originWorld}:${payload.publicationId}`},0))`.execute(
        trx,
      );
      await sql`update content.cutroom_receive_receipts set state='expired',lease_id=null,lease_until=null where handoff_id=${payload.handoffId}::uuid and world_id=${world} and state='pending' and hard_deadline<=clock_timestamp()`.execute(
        trx,
      );
      const old = (
        await sql<Row>`select * from content.cutroom_receive_receipts where world_id=${world} and (handoff_id=${payload.handoffId}::uuid or (origin_world=${payload.originWorld} and origin_publication_id=${payload.publicationId}::uuid)) for update`.execute(
          trx,
        )
      ).rows;
      if (old.length) {
        if (
          old.length !== 1 ||
          old[0]!.payload_utf8 !== envelope.payloadUtf8 ||
          old[0]!.payload_sha256 !== envelope.payloadSha256 ||
          old[0]!.state === 'expired'
        )
          return;
        if (old[0]!.state === 'pending') {
          if (!(await bindingLive(scope, binding))) return;
          if (!(await hasLiveReceiveWork(scope, world, payload.handoffId)))
            await enqueue(scope, { kind: 'receive', payload: { v: 1, worldId: world, handoffId: payload.handoffId } });
          if (!(await bindingLive(scope, binding))) throw new Error('CUTROOM_RECEIVE_ATTESTATION_EXPIRED');
        }
        return recordOf(old[0]!);
      }
      const inserted =
        await sql`insert into content.cutroom_receive_receipts(handoff_id,world_id,origin_world,origin_publication_id,generation,payload_utf8,payload_sha256,original_claimed_at,hard_deadline)
        select ${payload.handoffId}::uuid,${world},${payload.originWorld},${payload.publicationId}::uuid,${scope.authority.generation},${envelope.payloadUtf8},${envelope.payloadSha256},${payload.settlement.claimedAt}::timestamptz,${payload.settlement.claimedAt}::timestamptz+interval '720 hours'
        where ${payload.settlement.claimedAt}::timestamptz<=clock_timestamp() and ${payload.settlement.claimedAt}::timestamptz+interval '720 hours'>clock_timestamp() returning handoff_id`.execute(
          trx,
        );
      if (!inserted.rows.length) return;
      await enqueue(scope, { kind: 'receive', payload: { v: 1, worldId: world, handoffId: payload.handoffId } });
      if (!(await bindingLive(scope, binding))) throw new Error('CUTROOM_RECEIVE_ATTESTATION_EXPIRED');
      return load(scope, payload.handoffId, false);
    },
    load,
    async admit(scope, record, binding, media) {
      const trx = cutroomReceiveTransactionOf(scope),
        p = record.payload;
      if (
        !scope.enabled ||
        scope.mode !== 'admit' ||
        scope.authority.worldId !== world ||
        binding.generation !== scope.authority.generation ||
        binding.payloadSha256 !== record.payloadSha256 ||
        binding.handoffId !== p.handoffId ||
        !record.leaseId ||
        media.sha256 !== p.media.sha256 ||
        media.size !== p.media.sizeBytes ||
        media.key !== p.media.key ||
        media.probe.durationMs !== p.document.durationMs
      )
        return;
      if (p.document.fixture) {
        const name = (await sql<{ name: string }>`select current_database() name`.execute(trx)).rows[0]?.name;
        if (options.fixture !== true || !name || !/^(ks_it_|knowscroll_fixture_)/.test(name)) return;
      }
      // Lock may wait; all clocks/lease/deadline/binding predicates are read afterward.
      await sql`select handoff_id from content.cutroom_receive_receipts where handoff_id=${p.handoffId}::uuid and world_id=${world} for update`.execute(
        trx,
      );
      const current = (
        await sql<Row>`select * from content.cutroom_receive_receipts where handoff_id=${p.handoffId}::uuid and world_id=${world} and payload_sha256=${record.payloadSha256} and payload_utf8=${record.payloadUtf8}`.execute(
          trx,
        )
      ).rows[0];
      if (!current) return;
      if (current.state === 'admitted') return recordOf(current).receipt;
      const valid =
        (
          await sql`select 1 from content.cutroom_receive_receipts where handoff_id=${p.handoffId}::uuid and state='pending' and lease_id=${record.leaseId}::uuid and lease_until>clock_timestamp() and hard_deadline>clock_timestamp()
        and to_timestamp(${binding.observedAtMs}::double precision/1000)<=clock_timestamp() and clock_timestamp()<to_timestamp(${binding.expiresAtMs}::double precision/1000)`.execute(
            trx,
          )
        ).rows.length === 1;
      if (!valid) return;
      await sql`select pg_advisory_xact_lock(hashtextextended(${`content.asset:${p.document.assetId}`},0))`.execute(
        trx,
      );
      // An existing local identity is never adopted, overwritten or relabelled as a receiver.
      if (await trx.selectFrom('content.assets').select('id').where('id', '=', p.document.assetId).executeTakeFirst())
        return;
      await sql`insert into content.media_objects(id,logical_key,backend,sha256,size_bytes,mime,probe) values(${uuidv7()}::uuid,${media.key},'local',${media.sha256},${media.size},'video/mp4',${JSON.stringify(media.probe)}::jsonb) on conflict(sha256) do nothing`.execute(
        trx,
      );
      const known = (
        await sql<{
          id: string;
          logical_key: string;
          size: string;
          backend: string;
          mime: string;
        }>`select id,logical_key,size_bytes::text size,backend,mime from content.media_objects where sha256=${media.sha256}`.execute(
          trx,
        )
      ).rows[0];
      if (
        !known ||
        known.logical_key !== media.key ||
        Number(known.size) !== media.size ||
        known.backend !== 'local' ||
        known.mime !== 'video/mp4'
      )
        throw new Error('CUTROOM_RECEIVE_MEDIA_CONFLICT');
      await trx
        .insertInto('content.assets')
        .values({ id: p.document.assetId, revision: 1, kind: 'reel', status: 'admitted' })
        .execute();
      await trx
        .insertInto('content.asset_revisions')
        .values({
          asset_id: p.document.assetId,
          revision: 1,
          provenance_kind: 'cutroom_import',
          document_version: 'reel-document.v1',
          document: JSON.stringify(p.document),
          document_sha256: p.documentSha256,
          explanation_unit_id: `cutroom:${p.scriptSha256.slice(0, 32)}`,
          language: p.document.language,
          title: p.document.title,
          reading_facts: JSON.stringify({
            v: 2,
            measuresVersion: 'reel-duration.v1',
            totalWeight: 0,
            estimatedReadingMs: p.document.durationMs,
            blocks: [],
            nested: [],
            reelDurationMs: p.document.durationMs,
          }),
        })
        .execute();
      await trx
        .insertInto('content.asset_provenance')
        .values({
          asset_id: p.document.assetId,
          revision: 1,
          provenance_version: 'reel-provenance.v1',
          provenance: JSON.stringify({
            schemaVersion: 'reel-provenance.v1',
            kind: 'cutroom_import',
            receiverChargeCents: 0,
            handoffId: p.handoffId,
            payloadSha256: record.payloadSha256,
            originWorld: p.originWorld,
            publicationId: p.publicationId,
            publicationSha256: p.publicationSha256,
            originSettlementSha256: p.settlement.receiptSha256,
            scriptSha256: p.scriptSha256,
            probe: media.probe,
            fixture: p.document.fixture,
          }),
        })
        .execute();
      const receiptId = uuidv7();
      const utf8 = JSON.stringify({
        version: 'cutroom-receive-receipt.v1',
        receiptId,
        handoffId: p.handoffId,
        payloadSha256: record.payloadSha256,
        targetWorld: world,
        generation: scope.authority.generation,
        assetId: p.document.assetId,
        assetRevision: 1,
        mediaSha256: media.sha256,
        mediaBytes: media.size,
        receiverChargeCents: 0,
      });
      // Final clock check after every potentially waiting asset/media operation. Throw rolls back all writes.
      const completed =
        await sql`update content.cutroom_receive_receipts set state='admitted',receipt_id=${receiptId}::uuid,receipt_utf8=${utf8},receipt_sha256=${receiveSha256(utf8)},asset_id=${p.document.assetId}::uuid,asset_revision=1,media_id=${known.id}::uuid,admitted_at=clock_timestamp(),lease_id=null,lease_until=null
        where handoff_id=${p.handoffId}::uuid and state='pending' and lease_id=${record.leaseId}::uuid and lease_until>clock_timestamp() and hard_deadline>clock_timestamp() and clock_timestamp()<to_timestamp(${binding.expiresAtMs}::double precision/1000) returning handoff_id`.execute(
          trx,
        );
      if (!completed.rows.length) throw new Error('CUTROOM_RECEIVE_AUTHORITY_EXPIRED');
      // The owning0016 trigger created discovery from the admitted revision in this same TX.
      return {
        receiptId,
        handoffId: p.handoffId,
        assetId: p.document.assetId,
        assetRevision: 1,
        receiptSha256: receiveSha256(utf8),
      };
    },
    async end(scope, handoffId, leaseId) {
      await sql`update content.cutroom_receive_receipts set lease_id=null,lease_until=null where handoff_id=${handoffId}::uuid and world_id=${world} and state='pending' and lease_id=${leaseId}::uuid`.execute(
        cutroomReceiveTransactionOf(scope),
      );
    },
    async recover(input) {
      if (options.enabled !== true) return { scanned: 0, woken: 0 };
      const parsed = ReceiveRecoveryWorkSchema.safeParse(input);
      if (!parsed.success || (parsed.data.worldId && parsed.data.worldId !== world)) return { scanned: 0, woken: 0 };
      // Discovery never waits on individual receiving roots. Durable tail commits FIRST.
      const ids = await withTransaction(db, 'cutroom-receive-discovery', async (trx) => {
        await sql`set local statement_timeout='2s'`.execute(trx);
        const ceiling =
          parsed.data.throughId ??
          (
            await sql<{
              id: string;
            }>`select handoff_id id from content.cutroom_receive_receipts where world_id=${world} and state='pending' order by handoff_id desc limit 1`.execute(
              trx,
            )
          ).rows[0]?.id;
        if (!ceiling) return [];
        const after = parsed.data.afterId ?? '00000000-0000-0000-0000-000000000000';
        const rows = (
          await sql<{
            id: string;
          }>`select handoff_id id from content.cutroom_receive_receipts where world_id=${world} and state='pending' and handoff_id>${after}::uuid and handoff_id<=${ceiling}::uuid order by handoff_id limit 26`.execute(
            trx,
          )
        ).rows;
        if (rows.length > 25) {
          // A tiny live-map scope over this transaction is intentionally NOT minted here.
          // pg-boss direct send still uses this discovery TX, with fixed IDs-only closed payload.
          await enqueueReceiveRecoveryPage(boss, trx, {
            v: 1,
            worldId: world,
            afterId: rows[24]!.id,
            throughId: ceiling,
          });
        }
        return rows.slice(0, 25).map((r) => r.id);
      });
      let woken = 0;
      for (const id of ids) {
        try {
          const r = await withScope(authority, 'recover', async (scope) => {
            const trx = cutroomReceiveTransactionOf(scope);
            await sql`set local statement_timeout='2s'`.execute(trx);
            await sql`select handoff_id from content.cutroom_receive_receipts where handoff_id=${id}::uuid and world_id=${world} for update`.execute(
              trx,
            );
            const expired =
              await sql`update content.cutroom_receive_receipts set state='expired',lease_id=null,lease_until=null where handoff_id=${id}::uuid and state='pending' and hard_deadline<=clock_timestamp() returning handoff_id`.execute(
                trx,
              );
            if (expired.rows.length || !scope.enabled) return false;
            const due = (
              await sql`select 1 from content.cutroom_receive_receipts where handoff_id=${id}::uuid and state='pending' and recoveries<3 and deliveries<2880 and next_at<=clock_timestamp() and (lease_until is null or lease_until<=clock_timestamp())`.execute(
                trx,
              )
            ).rows.length;
            if (!due || (await hasLiveReceiveWork(scope, world, id))) return false;
            await enqueue(scope, { kind: 'receive', payload: { v: 1, worldId: world, handoffId: id } });
            await sql`update content.cutroom_receive_receipts set recoveries=recoveries+1,next_at=clock_timestamp()+interval '15 minutes',lease_id=null,lease_until=null where handoff_id=${id}::uuid and state='pending'`.execute(
              trx,
            );
            return true;
          });
          if (r.kind === 'entered' && r.value) woken++;
        } catch (error) {
          if (!['55P03', '57014'].includes(String((error as { code?: unknown }).code))) throw error;
        }
      }
      return { scanned: ids.length, woken };
    },
  };
}

import {
  enqueueReceiveRecoveryPage,
  hasLiveReceiveWork,
} from '../../../infrastructure/jobs/enqueue-cutroom-receive.js';
async function bindingLive(scope: ReceiveScopeTx, binding: CommissionReceiveBinding) {
  return (
    (
      await sql`select 1 where clock_timestamp()>='epoch'::timestamptz+${`${binding.observedAtMs} milliseconds`}::interval and clock_timestamp()<'epoch'::timestamptz+${`${binding.expiresAtMs} milliseconds`}::interval`.execute(
        cutroomReceiveTransactionOf(scope),
      )
    ).rows.length === 1
  );
}

import { cutroomPreparationTransactionOf } from '../../../infrastructure/postgres/cutroom-scope.js';
import { ReelDocumentSchema } from '@knowscroll/contracts';
import { confirmedSettlementValid } from '../../../reasoning/public.js';
import type { WithCutroomPreparationScope, CutroomConfirmedSettlementReader } from '../../../reasoning/public.js';
import type { CommissionReceiveOrigin } from '../production/commission-receive-ports.js';
import { parseCommissionReviewPacket } from '../production/commission-review.js';
import { receiveHandoffId } from '../production/commission-receive.js';
/** One server-enforced readonly repeatable-read snapshot across owning Content/Reasoning ports. */
export function postgresCommissionReceiveOrigin(options: {
  readonly authority: { readonly worldId: 'dev' | 'stage'; readonly generation: number };
  readonly withScope: WithCutroomPreparationScope;
  readonly financial: CutroomConfirmedSettlementReader;
  readonly source: { readonly commit: string; readonly artifactSha256: string; readonly schemaVersion: number };
  readonly fixture?: boolean;
}): CommissionReceiveOrigin {
  return {
    async read(publicationId, targetWorld) {
      if (targetWorld === options.authority.worldId) return;
      const result = await options.withScope(options.authority, async (scope) => {
        const trx = cutroomPreparationTransactionOf(scope);
        const latest = (
          await sql<{ name: string }>`select name from migrator.kysely_migration order by name desc limit 1`.execute(
            trx,
          )
        ).rows[0]?.name;
        if (!latest || Number(latest.slice(0, 4)) !== options.source.schemaVersion) return;
        const r = (
          await sql<{
            business_run_id: string;
            attempt_id: string;
            snapshot_id: string;
            snapshot_sha256: string;
            publication_utf8: string;
            publication_sha256: string;
            packet_utf8: string;
            document: unknown;
            document_sha256: string;
            asset_id: string;
            logical_key: string;
            media_sha256: string;
            size_bytes: string;
            commission_generation: number;
            commission_script_sha256: string;
            commission_evidence_sha256: string;
            commission_request_sha256: string;
            commission_request_id: string;
            human_evidence_ref: string;
            review_sha256: string;
          }>`
          select p.business_run_id,p.attempt_id,p.snapshot_id,p.snapshot_sha256,p.publication_utf8,p.publication_sha256,v.packet_utf8,r.document,r.document_sha256,p.asset_id,m.logical_key,m.sha256 media_sha256,m.size_bytes::text,
            c.generation commission_generation,c.script_sha256 commission_script_sha256,c.evidence_sha256 commission_evidence_sha256,c.request_sha256 commission_request_sha256,c.request_id commission_request_id,v.human_evidence_ref,v.review_sha256
          from content.cutroom_publications p join content.cutroom_reviews v using(world_id,business_run_id)
          join content.reel_commissions c using(world_id,business_run_id)
          join content.assets a on a.id=p.asset_id and a.revision=p.asset_revision and a.status='admitted' and a.kind='reel'
          join content.asset_revisions r on r.asset_id=p.asset_id and r.revision=p.asset_revision and r.document_version='reel-document.v1'
          join content.media_objects m on m.id=p.media_id and m.backend='local' and m.mime='video/mp4'
          where p.id=${publicationId}::uuid and p.world_id=${scope.authority.worldId} and c.attempt_id=p.attempt_id and v.revoked_at is null`.execute(
            trx,
          )
        ).rows[0];
        if (!r || receiveSha256(r.publication_utf8) !== r.publication_sha256) return;
        const packet = parseCommissionReviewPacket(JSON.parse(r.packet_utf8));
        const document = ReelDocumentSchema.safeParse(r.document);
        const financial = await options.financial.readConfirmed(scope, publicationId);
        if (!packet || !document.success || !financial || !confirmedSettlementValid(financial, receiveSha256)) return;
        if (document.data.fixture) {
          const name = (await sql<{ name: string }>`select current_database() name`.execute(trx)).rows[0]?.name;
          if (options.fixture !== true || !name || !/^(ks_it_|knowscroll_fixture_)/.test(name)) return;
        }
        const f = financial.financialReport;
        const publication: unknown = JSON.parse(r.publication_utf8);
        if (!publication || typeof publication !== 'object') return;
        const p = publication as Record<string, unknown>;
        if (
          packet.worldId !== scope.authority.worldId ||
          packet.businessRunId !== r.business_run_id ||
          packet.generation !== r.commission_generation ||
          packet.scriptSha256 !== r.commission_script_sha256 ||
          packet.evidenceSha256 !== r.commission_evidence_sha256 ||
          packet.requestSha256 !== r.commission_request_sha256 ||
          packet.requestId !== r.commission_request_id ||
          packet.reviewSha256 !== r.review_sha256 ||
          f.worldId !== scope.authority.worldId ||
          f.businessRunId !== r.business_run_id ||
          f.attemptId !== r.attempt_id ||
          f.requestId !== packet.requestId ||
          f.requestSha256 !== packet.requestSha256 ||
          financial.snapshotId !== r.snapshot_id ||
          financial.snapshotSha256 !== r.snapshot_sha256 ||
          p['version'] !== 'cutroom-publication.v1' ||
          p['worldId'] !== f.worldId ||
          p['businessRunId'] !== f.businessRunId ||
          p['attemptId'] !== f.attemptId ||
          p['snapshotId'] !== r.snapshot_id ||
          p['snapshotSha256'] !== r.snapshot_sha256 ||
          p['scriptSha256'] !== packet.scriptSha256 ||
          p['requestSha256'] !== packet.requestSha256 ||
          p['reviewSha256'] !== packet.reviewSha256 ||
          p['corpusSha256'] !== packet.corpusSnapshotSha256 ||
          p['finalRunId'] !== f.finalRunId ||
          p['actualCents'] !== f.actualCents ||
          p['mediaSha256'] !== r.media_sha256 ||
          p['mediaBytes'] !== Number(r.size_bytes) ||
          typeof p['humanEvidenceRef'] !== 'string' ||
          p['humanEvidenceRef'] !== r.human_evidence_ref ||
          document.data.assetId !== r.asset_id ||
          document.data.assetId !== r.business_run_id ||
          document.data.revision !== 1 ||
          document.data.mediaKey !== r.logical_key ||
          receiveSha256(JSON.stringify(document.data)) !== r.document_sha256
        )
          return;
        return {
          version: 'cutroom-receive.v1' as const,
          handoffId: receiveHandoffId(f.worldId, publicationId, targetWorld),
          originWorld: f.worldId,
          targetWorld,
          publicationId,
          publicationSha256: r.publication_sha256,
          businessRunId: r.business_run_id,
          attemptId: r.attempt_id,
          snapshotId: r.snapshot_id,
          snapshotSha256: r.snapshot_sha256,
          source: { ...options.source },
          policyVersion: 'cutroom-commission.v1' as const,
          scriptSha256: packet.scriptSha256,
          evidenceSha256: packet.evidenceSha256,
          requestId: packet.requestId,
          requestSha256: packet.requestSha256,
          reviewSha256: packet.reviewSha256,
          humanApprovalRef: p['humanEvidenceRef'],
          corpusSnapshotSha256: packet.corpusSnapshotSha256,
          rightsReviewRef: packet.rightsReviewRef,
          framingReviewRef: packet.framingReviewRef,
          targetReviewRef: packet.targetReviewRef,
          settlement: {
            operationId: financial.operationId,
            receiptSha256: financial.receiptSha256,
            financialReportSha256: financial.financialReportSha256,
            poolEvidenceId: financial.poolEvidenceId,
            dispatchId: f.dispatchId,
            ...f.poolReceipt,
            runs: f.runs.map((run) => ({ ...run })),
            finalRunId: f.finalRunId,
            actualCents: f.actualCents,
          },
          document: document.data,
          documentSha256: r.document_sha256,
          media: {
            sha256: r.media_sha256,
            sizeBytes: Number(r.size_bytes),
            key: r.logical_key,
            profile: 'h264-aac-reel.v1' as const,
          },
          receiverChargeCents: 0 as const,
        };
      });
      return result.kind === 'entered' ? result.value : undefined;
    },
  };
}
