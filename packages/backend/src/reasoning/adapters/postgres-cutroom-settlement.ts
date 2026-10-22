import type { CutroomReviewRecheck } from '../application/cutroom-execution-ports.js';
import type { CutroomOwnerApproval, CutroomBusinessLock } from '../application/cutroom-ports.js';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { cutroomTransactionOf, cutroomAccountingTransactionOf } from '../../infrastructure/postgres/cutroom-scope.js';
import type { EnqueueCutroom } from '../../infrastructure/jobs/enqueue-cutroom.js';
import type { CutroomSettlementStore, CutroomFinancialReport } from '../application/cutroom-settlement-ports.js';
import { parseCutroomFinancialReport } from '../application/cutroom-settlement.js';
import { canTransition } from '../domain/attempts.js';
import type { AttemptState } from '../domain/attempts.js';
import { cutroomSettleQueue } from '../events.js';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const textOf = (report: CutroomFinancialReport) => JSON.stringify(report);
const refOf = (digest: string) => `cutroom-financial:${digest}`;

/** Owns immutable financial reports. Collection/publication identities never change the
 * canonical pool report, so a lost hold acknowledgement and later settlement replay exactly. */
export function postgresCutroomSettlement(
  enqueue: EnqueueCutroom,
  enqueueAccounting: ReturnType<typeof makeEnqueueCutroomMaintenance>,
): CutroomSettlementStore {
  async function reportIn(
    trx: Transaction<Database>,
    world: string,
    business: string,
    attempt: string,
    snapshotId: string,
    input: CutroomFinancialReport,
    hold: boolean,
  ) {
    const report = parseCutroomFinancialReport(input);
    if (!report || report.worldId !== world || report.businessRunId !== business || report.attemptId !== attempt)
      return;
    const a = (
      await sql<{
        request_id: string;
        request_sha256: string;
        dispatch_id: string;
        binding_id: string;
        claimed: string;
        bound: string;
      }>`select a.request_id,a.request_sha256,e.dispatch_id,a.binding_id,
      to_char(a.claimed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') claimed,
      to_char(a.bound_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') bound
      from reasoning.cutroom_attempts a join reasoning.cutroom_execution e on e.attempt_id=a.id
      where a.id=${attempt}::uuid and a.world_id=${world} and a.business_run_id=${business}::uuid
        and a.binding_id=e.binding_id and a.claimed_at=e.claimed_at and a.bound_at=e.bound_at for update of a`.execute(
        trx,
      )
    ).rows[0];
    if (
      !a ||
      report.requestId !== a.request_id ||
      report.requestSha256 !== a.request_sha256 ||
      report.dispatchId !== a.dispatch_id ||
      JSON.stringify(report.poolReceipt) !==
        JSON.stringify({ bindingId: a.binding_id, claimedAt: a.claimed, boundAt: a.bound })
    )
      return;
    const utf8 = textOf(report),
      digest = hash(utf8);
    const old = (
      await sql<{
        id: string;
        evidence_sha256: string;
        hold_state: string;
      }>`select id,evidence_sha256,hold_state from reasoning.cutroom_financial_reports where attempt_id=${attempt}::uuid and evidence_sha256=${digest} for update`.execute(
        trx,
      )
    ).rows[0];
    if (old) {
      if (old.evidence_sha256 !== digest) return;
      if (hold && old.hold_state === 'none')
        await sql`update reasoning.cutroom_financial_reports set hold_state='pending',hold_next_at=clock_timestamp()+interval '15 minutes' where id=${old.id}::uuid`.execute(
          trx,
        );
      return { id: old.id, digest, report };
    }
    const count = (
      await sql<{
        n: string;
      }>`select count(*)::text n from reasoning.cutroom_financial_reports where attempt_id=${attempt}::uuid`.execute(
        trx,
      )
    ).rows[0];
    if (Number(count?.n) >= 32) return;
    const id = randomUUID();
    await sql`insert into reasoning.cutroom_financial_reports(id,world_id,business_run_id,attempt_id,snapshot_id,report_utf8,evidence_sha256,evidence_ref,actual_cents,outcome,final_run_id,hold_state,hold_next_at)
      values(${id}::uuid,${world},${business}::uuid,${attempt}::uuid,${snapshotId}::uuid,${utf8},${digest},${refOf(digest)},${String(report.actualCents)}::bigint,${report.outcome},${report.finalRunId},${hold ? 'pending' : 'none'},case when ${hold} then clock_timestamp()+interval '15 minutes' else null end)`.execute(
      trx,
    );
    return { id, digest, report };
  }
  return {
    async create(scope, attemptId, draft) {
      const trx = cutroomTransactionOf(scope);
      if (
        !scope.enabled ||
        scope.mode !== 'admit' ||
        draft.financialReport.outcome !== 'completed' ||
        draft.finalRunId !== draft.financialReport.finalRunId ||
        draft.actualCents !== draft.financialReport.actualCents
      )
        return;
      const a = (
        await sql<{
          business: string;
          ceiling: number;
          state: string;
        }>`select business_run_id business,ceiling_cents ceiling,state from reasoning.cutroom_attempts
        where id=${attemptId}::uuid and world_id=${scope.authority.worldId} and generation=${scope.authority.generation} and pool_state='claimed' for update`.execute(
          trx,
        )
      ).rows[0];
      if (!a || draft.actualCents > a.ceiling || draft.actualCents > 75) return;
      const f = await reportIn(
        trx,
        scope.authority.worldId,
        a.business,
        attemptId,
        draft.snapshotId,
        draft.financialReport,
        false,
      );
      if (!f) return;
      const old = (
        await sql<{
          id: string;
          publication_id: string;
          evidence_sha256: string;
        }>`select id,publication_id,evidence_sha256 from reasoning.cutroom_settlements where attempt_id=${attemptId}::uuid`.execute(
          trx,
        )
      ).rows[0];
      if (old)
        return old.evidence_sha256 === f.digest && old.publication_id === draft.publicationId ? old.id : undefined;
      if (!['dispatched', 'unknown'].includes(a.state)) return;
      const id = randomUUID(),
        r = f.report.poolReceipt;
      await sql`insert into reasoning.cutroom_settlements(id,world_id,business_run_id,attempt_id,publication_id,financial_report_id,snapshot_id,snapshot_sha256,final_run_id,actual_cents,evidence_sha256,evidence_ref,binding_id,claimed_at,bound_at)
        values(${id}::uuid,${scope.authority.worldId},${a.business}::uuid,${attemptId}::uuid,${draft.publicationId}::uuid,${f.id}::uuid,${draft.snapshotId}::uuid,${draft.snapshotSha256},${draft.finalRunId},${String(draft.actualCents)}::bigint,${f.digest},${refOf(f.digest)},${r.bindingId}::uuid,${r.claimedAt}::timestamptz,${r.boundAt}::timestamptz)`.execute(
        trx,
      );
      await enqueue(scope, cutroomSettleQueue, {
        v: 1,
        worldId: scope.authority.worldId,
        businessRunId: a.business,
        attemptId,
        operationId: id,
      });
      return id;
    },
    async createHold(scope, snapshotId, report) {
      const trx = cutroomAccountingTransactionOf(scope);
      const f = await reportIn(trx, scope.worldId, scope.businessRunId, scope.attemptId, snapshotId, report, true);
      if (!f) return;
      const done = (
        await sql`select 1 from reasoning.cutroom_settlements where attempt_id=${scope.attemptId}::uuid and state='confirmed' and evidence_sha256=${f.digest}`.execute(
          trx,
        )
      ).rows.length;
      if (done) return;
      await enqueueAccounting(scope, {
        kind: 'settle',
        payload: {
          v: 1,
          worldId: scope.worldId,
          businessRunId: scope.businessRunId,
          attemptId: scope.attemptId,
          operationId: f.id,
        },
      });
      return f.id;
    },
    async read(scope, operationId) {
      const trx = cutroomAccountingTransactionOf(scope);
      const row = (
        await sql<{
          id: string;
          snapshot_id: string;
          report_utf8: string;
          evidence_sha256: string;
          evidence_ref: string;
          hold_state: string;
          hold_evidence_id: string | null;
          snapshot_sha256: string;
          settlement_id: string | null;
          publication_id: string | null;
          settlement_snapshot_id: string | null;
          settlement_snapshot_sha256: string | null;
          state: 'pending' | 'held' | 'confirmed' | null;
          has_receipt: boolean;
        }>`select f.id,f.snapshot_id,f.report_utf8,f.evidence_sha256,f.evidence_ref,f.hold_state,f.hold_evidence_id,h.snapshot_sha256,
        s.id settlement_id,s.publication_id,s.snapshot_id settlement_snapshot_id,s.snapshot_sha256 settlement_snapshot_sha256,s.state,
        exists(select 1 from reasoning.cutroom_settlement_receipts r where r.settlement_id=s.id) has_receipt
        from reasoning.cutroom_financial_reports f join content.cutroom_chain_snapshots h on h.id=f.snapshot_id
        left join reasoning.cutroom_settlements s on s.financial_report_id=f.id
        where f.attempt_id=${scope.attemptId}::uuid and f.world_id=${scope.worldId} and f.business_run_id=${scope.businessRunId}::uuid
          and (f.id=${operationId}::uuid or s.id=${operationId}::uuid) for update of f`.execute(trx)
      ).rows[0];
      if (!row) return;
      const report = parseCutroomFinancialReport(JSON.parse(row.report_utf8));
      if (
        !report ||
        hash(textOf(report)) !== row.evidence_sha256 ||
        row.evidence_ref !== refOf(row.evidence_sha256) ||
        report.worldId !== scope.worldId ||
        report.businessRunId !== scope.businessRunId ||
        report.attemptId !== scope.attemptId ||
        report.requestId !== scope.identity.requestId ||
        report.requestSha256 !== scope.identity.requestSha256
      )
        throw new Error('CUTROOM_FINANCIAL_CORRUPT');
      const mode = operationId === row.settlement_id ? 'settle' : 'hold';
      if (
        mode === 'settle' &&
        (report.outcome !== 'completed' ||
          report.actualCents > scope.identity.ceilingCents ||
          report.actualCents > 75 ||
          (row.state === 'confirmed' && !row.has_receipt))
      )
        throw new Error('CUTROOM_SETTLEMENT_CORRUPT');
      if (mode === 'hold' && row.hold_state === 'none') return;
      return {
        operationId,
        mode,
        publicationId: mode === 'settle' ? row.publication_id : null,
        snapshotId: mode === 'settle' ? row.settlement_snapshot_id! : row.snapshot_id,
        snapshotSha256: mode === 'settle' ? row.settlement_snapshot_sha256! : row.snapshot_sha256,
        finalRunId: report.finalRunId,
        actualCents: report.actualCents,
        financialReport: report,
        identity: scope.identity,
        receipt: report.poolReceipt,
        evidenceSha256: row.evidence_sha256,
        evidenceRef: row.evidence_ref,
        holdEvidenceId: row.hold_evidence_id,
        state:
          mode === 'settle' ? row.state! : ['recorded', 'satisfied'].includes(row.hold_state) ? 'confirmed' : 'pending',
      };
    },
    async finish(scope, record, result) {
      const trx = cutroomAccountingTransactionOf(scope);
      if (result.kind === 'held') {
        if (record.mode === 'settle')
          await sql`update reasoning.cutroom_settlements set state='held' where id=${record.operationId}::uuid and attempt_id=${scope.attemptId}::uuid and state='pending'`.execute(
            trx,
          );
        return;
      }
      if (
        JSON.stringify(result.receipt) !== JSON.stringify(record.receipt) ||
        !/^[0-9a-f]{64}$/.test(result.evidenceId)
      )
        throw new Error('CUTROOM_SETTLEMENT_RECEIPT');
      if (record.mode === 'hold') {
        await sql`update reasoning.cutroom_financial_reports set hold_state='recorded',hold_evidence_id=${result.evidenceId},hold_next_at=null
          where id=${record.operationId}::uuid and attempt_id=${scope.attemptId}::uuid and hold_state='pending'`.execute(
          trx,
        );
        return;
      }
      const utf8 = JSON.stringify({
        version: 'cutroom-settlement-receipt.v1',
        operationId: record.operationId,
        evidenceSha256: record.evidenceSha256,
        evidenceId: result.evidenceId,
        receipt: result.receipt,
      });
      const old = (
        await sql<{
          receipt_sha256: string;
        }>`select receipt_sha256 from reasoning.cutroom_settlement_receipts where settlement_id=${record.operationId}::uuid`.execute(
          trx,
        )
      ).rows[0];
      if (old && old.receipt_sha256 !== hash(utf8)) throw new Error('CUTROOM_SETTLEMENT_RECEIPT_CONFLICT');
      if (!old)
        await sql`insert into reasoning.cutroom_settlement_receipts(settlement_id,pool_evidence_id,receipt_utf8,receipt_sha256) values(${record.operationId}::uuid,${result.evidenceId},${utf8},${hash(utf8)})`.execute(
          trx,
        );
      await sql`update reasoning.cutroom_settlements set state='confirmed' where id=${record.operationId}::uuid and attempt_id=${scope.attemptId}::uuid and state<>'confirmed'`.execute(
        trx,
      );
      await sql`update reasoning.cutroom_financial_reports set hold_state='satisfied',hold_evidence_id=${result.evidenceId},hold_next_at=null where attempt_id=${scope.attemptId}::uuid and evidence_sha256=${record.evidenceSha256} and hold_state<>'satisfied'`.execute(
        trx,
      );
      const a = await trx
        .selectFrom('reasoning.cutroom_attempts')
        .select('state')
        .where('id', '=', scope.attemptId)
        .executeTakeFirstOrThrow();
      const next = a.state === 'unknown' ? 'reconciled' : 'succeeded';
      if (canTransition(a.state as AttemptState, next))
        await trx
          .updateTable('reasoning.cutroom_attempts')
          .set({ state: next })
          .where('id', '=', scope.attemptId)
          .execute();
      await sql`update reasoning.cutroom_maintenance set stopped_at=clock_timestamp(),lease_id=null,lease_until=null where attempt_id=${scope.attemptId}::uuid and stopped_at is null`.execute(
        trx,
      );
    },
  };
}

import type { Kysely } from 'kysely';
import type { PgBoss } from 'pg-boss';
import type { Database } from '../../infrastructure/postgres/database.js';
import { withTransaction } from '../../infrastructure/postgres/personal-scope.js';
import { makeWithCutroomAccountingScope, makeWithCutroomScope } from '../../infrastructure/postgres/cutroom-scope.js';
import {
  makeEnqueueCutroom,
  makeEnqueueCutroomMaintenance,
  hasLiveCutroomWork,
  enqueueCutroomRecoveryPage,
} from '../../infrastructure/jobs/enqueue-cutroom.js';
import { CutroomRecoveryWorkSchema, CutroomPoolWorkSchema, cutroomPoolQueue } from '../events.js';
import type { CutroomMaintenance } from '../application/cutroom-settlement-ports.js';
import type { CutroomAccountingScopeTx, CutroomAccountingTarget } from '../application/cutroom-execution-ports.js';

/** One finite delivery/pass. The advancing pg-boss child commits before per-root work,
 * including skipped live/busy heads; restart cannot lose the tail or reopen a paid send. */
export function cutroomMaintenanceFor(
  db: Kysely<Database>,
  boss: PgBoss,
  options: {
    readonly enabled?: boolean;
    readonly worldId: 'dev' | 'stage';
    readonly lockBusiness: CutroomBusinessLock;
  },
): CutroomMaintenance {
  const enabled = options.enabled === true,
    world = options.worldId;
  const accounting = makeWithCutroomAccountingScope(db, { enabled, lockTimeoutMs: 250 });
  const current = makeWithCutroomScope(db, { enabled, lockTimeoutMs: 250 });
  const enqueue = makeEnqueueCutroom(boss),
    maintenance = makeEnqueueCutroomMaintenance(boss);
  async function bookkeeping(scope: CutroomAccountingScopeTx, leaseId: string | undefined, recovery: boolean) {
    const trx = cutroomAccountingTransactionOf(scope);
    await sql`set local statement_timeout='2s'`.execute(trx);
    if (recovery) {
      const due = (
        await sql<{
          id: string;
        }>`select id from reasoning.cutroom_financial_reports where attempt_id=${scope.attemptId}::uuid and hold_state='pending' and hold_recoveries<3 and hold_next_at<=now() order by id limit 1 for update`.execute(
          trx,
        )
      ).rows[0];
      if (due) {
        if (await hasLiveCutroomWork(scope)) return;
        await maintenance(scope, {
          kind: 'settle',
          payload: {
            v: 1,
            worldId: scope.worldId,
            businessRunId: scope.businessRunId,
            attemptId: scope.attemptId,
            operationId: due.id,
          },
        });
        await sql`update reasoning.cutroom_financial_reports set hold_recoveries=hold_recoveries+1,hold_next_at=clock_timestamp()+interval '15 minutes' where id=${due.id}::uuid`.execute(
          trx,
        );
        return { woken: true as const };
      }
    }
    const m = (
      await sql<{
        deliveries: number;
        recoveries: number;
        lease_id: string | null;
        busy: boolean;
        due: boolean;
      }>`select deliveries,recoveries,lease_id,
      coalesce(lease_until>now(),false) busy,next_at<=now() due from reasoning.cutroom_maintenance
      where attempt_id=${scope.attemptId}::uuid and stopped_at is null for update`.execute(trx)
    ).rows[0];
    if (!m || (recovery && (!m.due || m.busy || m.recoveries >= 3)) || (!recovery && m.lease_id !== leaseId)) return;
    if (recovery && (await hasLiveCutroomWork(scope))) return;
    const s = (
      await sql<{
        id: string;
        state: string;
      }>`select id,state from reasoning.cutroom_settlements where attempt_id=${scope.attemptId}::uuid`.execute(trx)
    ).rows[0];
    const hold = (
      await sql<{
        id: string;
      }>`select id from reasoning.cutroom_financial_reports where attempt_id=${scope.attemptId}::uuid and hold_state='pending' order by id limit 1`.execute(
        trx,
      )
    ).rows[0];
    const e = (
      await sql<{
        dispatch_id: string;
        valid: boolean;
      }>`select dispatch_id,follow_until>now() valid from reasoning.cutroom_execution where attempt_id=${scope.attemptId}::uuid`.execute(
        trx,
      )
    ).rows[0];
    if (s?.state === 'confirmed' || m.deliveries >= 2880 || (e && !e.valid && !s && !hold)) {
      await sql`update reasoning.cutroom_maintenance set stopped_at=clock_timestamp(),lease_id=null,lease_until=null where attempt_id=${scope.attemptId}::uuid and stopped_at is null`.execute(
        trx,
      );
      return;
    }
    if (!e) {
      const a = (
        await sql<{
          generation: number;
          state: string;
          valid: boolean;
        }>`select generation,state,expires_at>now() valid from reasoning.cutroom_attempts where id=${scope.attemptId}::uuid`.execute(
          trx,
        )
      ).rows[0]!;
      if (a.state !== 'reserved' || !a.valid || a.generation !== scope.currentGeneration) {
        await sql`update reasoning.cutroom_maintenance set stopped_at=clock_timestamp(),lease_id=null,lease_until=null where attempt_id=${scope.attemptId}::uuid and stopped_at is null`.execute(
          trx,
        );
        return;
      }
      const root = (
        await sql<{ enabled: boolean }>`select enabled from reasoning.cutroom_scopes where world_id=${world}`.execute(
          trx,
        )
      ).rows[0];
      if (!root?.enabled) {
        await sql`update reasoning.cutroom_maintenance set next_at=clock_timestamp()+interval '15 minutes',lease_id=null,lease_until=null,recoveries=recoveries+${recovery ? 1 : 0} where attempt_id=${scope.attemptId}::uuid`.execute(
          trx,
        );
        return;
      }
      return { generation: a.generation };
    }
    if (s)
      await maintenance(
        scope,
        {
          kind: 'settle',
          payload: {
            v: 1,
            worldId: scope.worldId,
            businessRunId: scope.businessRunId,
            attemptId: scope.attemptId,
            operationId: s.id,
          },
        },
        recovery ? undefined : new Date(Date.now() + 900000),
      );
    else if (hold)
      await maintenance(
        scope,
        {
          kind: 'settle',
          payload: {
            v: 1,
            worldId: scope.worldId,
            businessRunId: scope.businessRunId,
            attemptId: scope.attemptId,
            operationId: hold.id,
          },
        },
        recovery ? undefined : new Date(Date.now() + 900000),
      );
    else
      await maintenance(
        scope,
        {
          kind: 'follow',
          payload: {
            v: 1,
            worldId: scope.worldId,
            businessRunId: scope.businessRunId,
            attemptId: scope.attemptId,
            dispatchId: e.dispatch_id,
          },
        },
        recovery ? undefined : new Date(Date.now() + 900000),
      );
    await sql`update reasoning.cutroom_maintenance set next_at=clock_timestamp()+interval '15 minutes',lease_id=null,lease_until=null,
      recoveries=recoveries+${recovery ? 1 : 0},recovered_at=case when ${recovery} then clock_timestamp() else recovered_at end
      where attempt_id=${scope.attemptId}::uuid and stopped_at is null`.execute(trx);
    return { woken: true as const };
  }
  async function wake(target: CutroomAccountingTarget, leaseId: string | undefined, recovery: boolean) {
    const first = await accounting(target, (scope) => bookkeeping(scope, leaseId, recovery));
    if (first.kind !== 'entered' || !first.value) return false;
    if ('woken' in first.value) return true;
    // A historical accounting capability cannot wake a claim. Re-enter CURRENT enabled
    // admission scope and recheck the same existing operation before the fixed pool enqueue.
    const generation = first.value.generation;
    const r = await current({ worldId: target.worldId, generation }, 'admit', async (scope) => {
      const trx = cutroomTransactionOf(scope);
      await sql`set local statement_timeout='2s'`.execute(trx);
      if (!(await options.lockBusiness(scope, target.businessRunId))) return false;
      const a = await trx
        .selectFrom('reasoning.cutroom_attempts')
        .select(['state', 'dispatch_intent_at', 'business_run_id'])
        .where('id', '=', target.attemptId)
        .where('world_id', '=', world)
        .forUpdate()
        .executeTakeFirst();
      if (!a || a.business_run_id !== target.businessRunId || a.state !== 'reserved' || a.dispatch_intent_at !== null)
        return false;
      const m = (
        await sql<{
          lease_id: string | null;
          busy: boolean;
          due: boolean;
          recoveries: number;
        }>`select lease_id,coalesce(lease_until>now(),false) busy,next_at<=now() due,recoveries
        from reasoning.cutroom_maintenance where attempt_id=${target.attemptId}::uuid and stopped_at is null for update`.execute(
          trx,
        )
      ).rows[0];
      if (!m || (recovery ? !m.due || m.busy || m.recoveries >= 3 : m.lease_id !== leaseId)) return false;
      const op = await trx
        .selectFrom('reasoning.cutroom_pool_operations')
        .select('id')
        .where('attempt_id', '=', target.attemptId)
        .where('kind', '=', 'claim')
        .executeTakeFirst();
      if (!op) return false;
      await enqueue(
        scope,
        cutroomPoolQueue,
        { v: 1, worldId: world, generation, attemptId: target.attemptId, operationId: op.id },
        recovery ? undefined : new Date(Date.now() + 900000),
      );
      await sql`update reasoning.cutroom_maintenance set next_at=clock_timestamp()+interval '15 minutes',lease_id=null,lease_until=null,
        recoveries=recoveries+${recovery ? 1 : 0},recovered_at=case when ${recovery} then clock_timestamp() else recovered_at end where attempt_id=${target.attemptId}::uuid`.execute(
        trx,
      );
      return true;
    });
    return r.kind === 'entered' && r.value;
  }
  return {
    async trackInScope(scope, attemptId) {
      const trx = cutroomTransactionOf(scope);
      if (!enabled || !scope.enabled || scope.mode !== 'admit' || scope.authority.worldId !== world)
        throw new Error('CUTROOM_TRACK_AUTHORITY');
      const a = await trx
        .selectFrom('reasoning.cutroom_attempts')
        .select('business_run_id')
        .where('id', '=', attemptId)
        .where('world_id', '=', world)
        .where('generation', '=', scope.authority.generation)
        .executeTakeFirst();
      if (!a) throw new Error('CUTROOM_TRACK_IDENTITY');
      await sql`insert into reasoning.cutroom_maintenance(attempt_id,world_id,business_run_id,next_at)
        values(${attemptId}::uuid,${world},${a.business_run_id}::uuid,clock_timestamp()+interval '5 minutes') on conflict do nothing`.execute(
        trx,
      );
    },
    async begin(target) {
      if (!enabled || target.worldId !== world) return;
      const r = await accounting(target, async (scope) => {
        const id = randomUUID();
        const changed =
          await sql`update reasoning.cutroom_maintenance set lease_id=${id}::uuid,lease_until=clock_timestamp()+interval '90 seconds',deliveries=deliveries+1
          where attempt_id=${scope.attemptId}::uuid and stopped_at is null and deliveries<2880 and (lease_until is null or lease_until<=now()) returning attempt_id`.execute(
            cutroomAccountingTransactionOf(scope),
          );
        return changed.rows.length === 1 ? id : undefined;
      });
      return r.kind === 'entered' ? r.value : undefined;
    },
    async end(target, leaseId) {
      if (enabled && target.worldId === world) await wake(target, leaseId, false);
    },
    async recover(input) {
      const parsed = CutroomRecoveryWorkSchema.safeParse(input);
      if (!enabled || !parsed.success) return { scanned: 0, woken: 0 };
      const rows = await withTransaction(db, 'cutroom-recovery-page', async (trx) => {
        await sql`set local statement_timeout='2s'`.execute(trx);
        await sql`set local lock_timeout='250ms'`.execute(trx);
        const after = 'afterAttemptId' in parsed.data ? parsed.data.afterAttemptId : null;
        const through =
          'throughAttemptId' in parsed.data
            ? parsed.data.throughAttemptId
            : (
                await sql<{
                  id: string;
                }>`select attempt_id id from reasoning.cutroom_maintenance where world_id=${world} order by attempt_id desc limit 1`.execute(
                  trx,
                )
              ).rows[0]?.id;
        if (!through) return [];
        const page = (
          await sql<{
            attemptId: string;
            businessRunId: string;
          }>`select attempt_id as "attemptId",business_run_id as "businessRunId" from reasoning.cutroom_maintenance
          where world_id=${world} and ((stopped_at is null and next_at<=now() and recoveries<3) or exists(select 1 from reasoning.cutroom_financial_reports f where f.attempt_id=reasoning.cutroom_maintenance.attempt_id and f.hold_state='pending' and f.hold_recoveries<3 and f.hold_next_at<=now()))
            and (${after}::uuid is null or attempt_id>${after}::uuid) and attempt_id<=${through}::uuid order by attempt_id limit 26`.execute(
            trx,
          )
        ).rows;
        if (page.length > 25)
          await enqueueCutroomRecoveryPage(boss, trx, {
            v: 1,
            afterAttemptId: page[24]!.attemptId,
            throughAttemptId: through,
          });
        return page.slice(0, 25);
      });
      let woken = 0;
      for (const row of rows) {
        try {
          if (await wake({ worldId: world, ...row }, undefined, true)) woken++;
        } catch {
          /* Exact pending liability remains; the next bounded wave can reconcile. */
        }
      }
      return { scanned: rows.length, woken };
    },
  };
}

/** Fixed queue receipt lookup. The caller cannot replace an operation or supply a principal.
 * Re-enters the current world/business root before returning immutable ledger metadata. */
export function cutroomPoolWorkReader(
  db: Kysely<Database>,
  options: {
    readonly enabled?: boolean;
    readonly lockBusiness: CutroomBusinessLock;
    readonly approvals?: readonly CutroomOwnerApproval[];
    readonly recheckReview?: CutroomReviewRecheck;
  },
) {
  const approvals = structuredClone(options.approvals ?? []);
  const current = makeWithCutroomScope(db, { enabled: options.enabled === true, lockTimeoutMs: 5000 });
  return async (input: unknown) => {
    const p = CutroomPoolWorkSchema.safeParse(input);
    if (!p.success || options.enabled !== true) return;
    const x = p.data;
    const r = await current({ worldId: x.worldId, generation: x.generation }, 'admit', async (scope) => {
      const trx = cutroomTransactionOf(scope);
      const peek = await trx
        .selectFrom('reasoning.cutroom_attempts')
        .select('business_run_id')
        .where('id', '=', x.attemptId)
        .where('world_id', '=', x.worldId)
        .executeTakeFirst();
      if (!peek || !(await options.lockBusiness(scope, peek.business_run_id))) return;
      const a = await trx
        .selectFrom('reasoning.cutroom_attempts')
        .selectAll()
        .where('id', '=', x.attemptId)
        .where('world_id', '=', x.worldId)
        .where('generation', '=', x.generation)
        .forUpdate()
        .executeTakeFirst();
      const op = await trx
        .selectFrom('reasoning.cutroom_pool_operations')
        .select(['kind', 'state'])
        .where('id', '=', x.operationId)
        .where('attempt_id', '=', x.attemptId)
        .executeTakeFirst();
      if (
        !a ||
        a.business_run_id !== peek.business_run_id ||
        !op ||
        op.kind !== 'claim' ||
        a.dispatch_intent_at !== null ||
        !['reserved', 'dispatched'].includes(a.state)
      )
        return;
      if (
        approvals.filter(
          (p) =>
            p.worldId === a.world_id &&
            p.businessRunId === a.business_run_id &&
            p.generation === a.generation &&
            p.policyVersion === a.policy_version &&
            p.scriptSha256 === a.script_sha256 &&
            p.evidenceSha256 === a.evidence_sha256 &&
            p.requestSha256 === a.request_sha256 &&
            p.requestId === a.request_id &&
            p.take === a.take &&
            p.ceilingCents === a.ceiling_cents &&
            p.approvalRef === a.approval_ref &&
            p.principalOid === a.principal_oid &&
            p.principalName === a.principal_name &&
            p.grantRef === 'knowscroll-v2-d018' &&
            p.until === 'video',
        ).length !== 1 ||
        !(await options.recheckReview?.(scope, a.business_run_id))
      )
        return;
      return {
        claimPending: op.state === 'pending',
        target: { worldId: x.worldId, businessRunId: a.business_run_id, attemptId: x.attemptId },
        authority: scope.authority,
        identity: {
          worldId: x.worldId,
          grantRef: 'knowscroll-v2-d018' as const,
          requestId: a.request_id,
          scriptSha256: a.script_sha256,
          take: a.take,
          until: 'video' as const,
          requestSha256: a.request_sha256,
          ceilingCents: a.ceiling_cents,
          approvalRef: a.approval_ref,
          principalOid: a.principal_oid,
          principalName: a.principal_name,
        },
      };
    });
    return r.kind === 'entered' ? r.value : undefined;
  };
}
