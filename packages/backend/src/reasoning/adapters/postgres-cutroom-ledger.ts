import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { uuidv7 } from '../../infrastructure/ids/index.js';
import { cutroomTransactionOf } from '../../infrastructure/postgres/cutroom-scope.js';
import type { EnqueueCutroom } from '../../infrastructure/jobs/enqueue-cutroom.js';
import { cutroomPoolQueue } from '../events.js';
import type {
  CutroomLedger,
  CutroomAttemptRecord,
  CutroomScopeTx,
  CutroomPoolOperation,
  CutroomPoolReceipt,
} from '../application/cutroom-ports.js';
import { canTransitionCutroomAttempt } from '../domain/cutroom-attempt.js';
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const states = z.enum([
  'reserved',
  'not_sent',
  'dispatched',
  'succeeded',
  'failed',
  'unknown',
  'reconciled',
  'written_off',
]);
const rowSchema = z.object({
  id: z.uuid(),
  world_id: z.enum(['dev', 'stage']),
  business_run_id: z.uuid(),
  generation: z.number().int().positive(),
  request_id: z.string(),
  script_sha256: hex,
  evidence_sha256: hex,
  policy_version: z.literal('cutroom-commission.v1'),
  request_sha256: hex,
  request_bytes: z.number().int().min(1).max(100000),
  contract_version: z.literal(1),
  take: z.number().int().min(1).max(999),
  until: z.literal('video'),
  ceiling_cents: z.number().int().min(1).max(75),
  approval_ref: z.string().min(1).max(128),
  grant_ref: z.literal('knowscroll-v2-d018'),
  principal_oid: z.string(),
  principal_name: z.string(),
  state: states,
  fence: z.number().int().positive(),
  pool_state: z.enum(['pending', 'claimed', 'released', 'held']),
  binding_id: z.uuid().nullable(),
});
const receiptTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
const iso = (v: unknown): string => {
  if (!(v instanceof Date) && typeof v !== 'string') throw new Error('CUTROOM_TIME_INVALID');
  return new Date(v).toISOString();
};
function record(input: Record<string, unknown>): CutroomAttemptRecord {
  const r = rowSchema.parse(input);
  const receipt: CutroomPoolReceipt | null =
    r.binding_id === null
      ? null
      : {
          bindingId: r.binding_id,
          claimedAt: receiptTime.parse(input['claimed_at']),
          boundAt: receiptTime.parse(input['bound_at']),
        };
  return {
    attemptId: r.id,
    candidate: {
      businessRunId: r.business_run_id,
      generation: r.generation,
      worldId: r.world_id,
      requestId: r.request_id,
      scriptSha256: r.script_sha256,
      evidenceSha256: r.evidence_sha256,
      policyVersion: r.policy_version,
      requestSha256: r.request_sha256,
      byteLength: r.request_bytes,
      contractVersion: r.contract_version,
      take: r.take,
      until: r.until,
      ceilingCents: r.ceiling_cents,
      approvalRef: r.approval_ref,
      grantRef: r.grant_ref,
      principalOid: r.principal_oid,
      principalName: r.principal_name,
    },
    state: r.state,
    fence: r.fence,
    dispatchIntentAt: input['dispatch_intent_at'] === null ? null : iso(input['dispatch_intent_at']),
    expiresAt: iso(input['expires_at']),
    purged: input['request_utf8'] === null,
    poolReceipt: receipt,
    poolState: r.pool_state,
  };
}
const operationSchema = z.object({
  id: z.uuid(),
  attempt_id: z.uuid(),
  kind: z.enum(['claim', 'release']),
  fence: z.number().int().positive(),
  state: z.enum(['pending', 'in_flight', 'confirmed', 'held']),
});
function operation(input: unknown): CutroomPoolOperation {
  const r = operationSchema.parse(input);
  return { operationId: r.id, attemptId: r.attempt_id, kind: r.kind, fence: r.fence, state: r.state };
}
export function postgresCutroomLedger(enqueue: EnqueueCutroom, now: () => Date = () => new Date()): CutroomLedger {
  async function find(
    scope: CutroomScopeTx,
    predicate: ReturnType<typeof sql>,
  ): Promise<CutroomAttemptRecord | undefined> {
    const rows = await sql<Record<string, unknown>>`select a.*,r.request_utf8,
   to_char(a.claimed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as claimed_at,
   to_char(a.bound_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as bound_at
   from reasoning.cutroom_attempts a join reasoning.cutroom_requests r on r.attempt_id=a.id
   where a.world_id=${scope.authority.worldId} and ${predicate} for update of a`.execute(cutroomTransactionOf(scope));
    return rows.rows[0] ? record(rows.rows[0]) : undefined;
  }
  async function work(scope: CutroomScopeTx, a: CutroomAttemptRecord, op: CutroomPoolOperation) {
    await enqueue(scope, cutroomPoolQueue, {
      v: 1,
      worldId: scope.authority.worldId,
      generation: scope.authority.generation,
      attemptId: a.attemptId,
      operationId: op.operationId,
    });
  }
  const ledger: CutroomLedger = {
    async identify(scope, id) {
      const r = await sql<{
        business_run_id: string;
      }>`select business_run_id from reasoning.cutroom_attempts where world_id=${scope.authority.worldId} and id=${id}::uuid`.execute(
        cutroomTransactionOf(scope),
      );
      return r.rows[0]?.business_run_id;
    },
    find: (scope, id) => find(scope, sql`a.id=${id}::uuid`),
    findBusiness: (scope, id) => find(scope, sql`a.business_run_id=${id}::uuid`),
    async reserve(scope, c) {
      if (
        scope.mode !== 'admit' ||
        !scope.enabled ||
        c.worldId !== scope.authority.worldId ||
        c.generation !== scope.authority.generation
      )
        throw new Error('CUTROOM_SCOPE_REFUSED');
      const trx = cutroomTransactionOf(scope),
        id = uuidv7(),
        op = uuidv7(),
        created = now(),
        expires = new Date(created.getTime() + 30 * 86400000);
      await sql`insert into reasoning.cutroom_attempts(id,world_id,business_run_id,generation,request_id,script_sha256,evidence_sha256,policy_version,request_sha256,request_bytes,contract_version,take,until,ceiling_cents,approval_ref,grant_ref,principal_oid,principal_name,expires_at)
    values(${id}::uuid,${c.worldId},${c.businessRunId}::uuid,${c.generation},${c.requestId},${c.scriptSha256},${c.evidenceSha256},${c.policyVersion},${c.requestSha256},${c.byteLength},1,${c.take},${c.until},${c.ceilingCents},${c.approvalRef},${c.grantRef},${c.principalOid},${c.principalName},${expires})`.execute(
        trx,
      );
      await sql`insert into reasoning.cutroom_requests(attempt_id,request_sha256,byte_length,contract_version,created_at,expires_at,request_utf8)
    values(${id}::uuid,${c.requestSha256},${c.byteLength},1,${created},${expires},${c.requestUtf8})`.execute(trx);
      await sql`insert into reasoning.cutroom_pool_operations(id,attempt_id,kind,operation_version,fence) values(${op}::uuid,${id}::uuid,'claim',1,1)`.execute(
        trx,
      );
      const a = (await ledger.find(scope, id))!;
      await work(scope, a, { operationId: op, attemptId: id, kind: 'claim', state: 'pending', fence: 1 });
      return a;
    },
    async request(scope, a) {
      const rows = await sql<{
        request_utf8: string | null;
        request_sha256: string;
        byte_length: number;
        contract_version: number;
        expires_at: Date;
      }>`select request_utf8,request_sha256,byte_length,contract_version,expires_at from reasoning.cutroom_requests where attempt_id=${a.attemptId}::uuid`.execute(
        cutroomTransactionOf(scope),
      );
      const r = rows.rows[0];
      if (!r || r.request_utf8 === null || now().getTime() >= new Date(r.expires_at).getTime()) return undefined;
      if (
        r.contract_version !== 1 ||
        r.request_sha256 !== a.candidate.requestSha256 ||
        r.byte_length !== a.candidate.byteLength ||
        r.byte_length > 100000 ||
        Buffer.byteLength(r.request_utf8, 'utf8') !== r.byte_length ||
        createHash('sha256').update(r.request_utf8, 'utf8').digest('hex') !== r.request_sha256
      )
        throw new Error('CUTROOM_REQUEST_INVALID');
      return r.request_utf8;
    },
    async operation(scope, a, kind) {
      const rows =
        await sql`select * from reasoning.cutroom_pool_operations where attempt_id=${a.attemptId}::uuid and kind=${kind} for update`.execute(
          cutroomTransactionOf(scope),
        );
      return rows.rows[0] ? operation(rows.rows[0]) : undefined;
    },
    async start(scope, op) {
      const result =
        await sql`update reasoning.cutroom_pool_operations set state='in_flight' where id=${op.operationId}::uuid and attempt_id=${op.attemptId}::uuid and fence=${op.fence}`.execute(
          cutroomTransactionOf(scope),
        );
      if (result.numAffectedRows !== 1n) throw new Error('CUTROOM_OPERATION_MISSING');
    },
    async observe(scope, a, op, result) {
      const trx = cutroomTransactionOf(scope);
      const stored = await ledger.operation(scope, a, op.kind);
      if (!stored || stored.operationId !== op.operationId || stored.fence !== op.fence)
        throw new Error('CUTROOM_OPERATION_CHANGED');
      if (result.kind === 'held') {
        await sql`update reasoning.cutroom_pool_operations set state='held' where id=${op.operationId}::uuid`.execute(
          trx,
        );
        await sql`update reasoning.cutroom_attempts set pool_state='held' where id=${a.attemptId}::uuid`.execute(trx);
        return;
      }
      if (a.poolReceipt && JSON.stringify(a.poolReceipt) !== JSON.stringify(result.receipt))
        throw new Error('CUTROOM_POOL_BINDING_CHANGED');
      if (result.state === 'released' && (a.state !== 'not_sent' || a.dispatchIntentAt !== null))
        throw new Error('CUTROOM_RELEASE_UNPROVEN');
      const r = result.receipt;
      await sql`update reasoning.cutroom_attempts set binding_id=${r.bindingId}::uuid,claimed_at=${r.claimedAt}::timestamptz,bound_at=${r.boundAt}::timestamptz,pool_state=${result.state} where id=${a.attemptId}::uuid`.execute(
        trx,
      );
      if ((op.kind === 'claim' && result.state === 'claimed') || (op.kind === 'release' && result.state === 'released'))
        await sql`update reasoning.cutroom_pool_operations set state='confirmed' where id=${op.operationId}::uuid`.execute(
          trx,
        );
    },
    async cancel(scope, a) {
      if (a.dispatchIntentAt !== null || !canTransitionCutroomAttempt(a.state, 'not_sent') || a.fence === 2147483647)
        throw new Error('CUTROOM_NOT_SENT_UNPROVEN');
      await sql`update reasoning.cutroom_attempts set state='not_sent',fence=fence+1 where id=${a.attemptId}::uuid and state='reserved' and dispatch_intent_at is null and fence=${a.fence}`.execute(
        cutroomTransactionOf(scope),
      );
      const next = (await ledger.find(scope, a.attemptId))!,
        op = await ledger.operation(scope, next, 'claim');
      if (op) await work(scope, next, op);
      return next;
    },
    async releaseIntent(scope, a) {
      if (a.state !== 'not_sent' || a.dispatchIntentAt !== null || !a.poolReceipt)
        throw new Error('CUTROOM_NOT_SENT_UNPROVEN');
      const old = await ledger.operation(scope, a, 'release');
      if (old) {
        if (old.fence !== a.fence) throw new Error('CUTROOM_RELEASE_FENCE_CHANGED');
        return old;
      }
      const id = uuidv7();
      await sql`insert into reasoning.cutroom_pool_operations(id,attempt_id,kind,operation_version,fence) values(${id}::uuid,${a.attemptId}::uuid,'release',1,${a.fence})`.execute(
        cutroomTransactionOf(scope),
      );
      const op = (await ledger.operation(scope, a, 'release'))!;
      await work(scope, a, op);
      return op;
    },
    async expired(scope, limit) {
      const rows = await sql<{
        attemptId: string;
        businessRunId: string;
      }>`select a.id as "attemptId",a.business_run_id as "businessRunId" from reasoning.cutroom_attempts a join reasoning.cutroom_requests r on a.id=r.attempt_id where a.world_id=${scope.authority.worldId} and r.expires_at<=${now()} and r.request_utf8 is not null order by a.business_run_id,a.id limit ${limit}`.execute(
        cutroomTransactionOf(scope),
      );
      return rows.rows;
    },
    async purge(scope, a) {
      await sql`update reasoning.cutroom_requests set request_utf8=null,purged_at=${now()} where attempt_id=${a.attemptId}::uuid and expires_at<=${now()} and request_utf8 is not null`.execute(
        cutroomTransactionOf(scope),
      );
    },
  };
  return ledger;
}
