import { fromKysely, type PgBoss } from 'pg-boss';
import { sql, type Transaction } from 'kysely';
import type { Database } from '../postgres/database.js';
import type { CutroomScopeTx } from '../../reasoning/public.js';
import { cutroomTransactionOf } from '../postgres/cutroom-scope.js';
import type { QueueDefinition } from './queues.js';
export type EnqueueCutroom = <T>(
  scope: CutroomScopeTx,
  queue: QueueDefinition<T>,
  payload: T,
  startAfter?: Date,
) => Promise<void>;
/** Same live world transaction, never a PersonalScopeTx cast or a second outbox. */
export function makeEnqueueCutroom(boss: PgBoss): EnqueueCutroom {
  return async (scope, queue, payload, startAfter) => {
    const trx = cutroomTransactionOf(scope);
    const name = queue.name;
    const schema = worldWork[name];
    if (!schema) throw new Error('CUTROOM_FIXED_QUEUE_REQUIRED');
    const data = schema.parse(payload);
    if (data.worldId !== scope.authority.worldId) throw new Error('CUTROOM_JOB_WORLD_MISMATCH');
    // The fixed local schema alone validates; caller callbacks cannot mutate parsed work.
    if (startAfter && (!Number.isFinite(startAfter.getTime()) || startAfter.getTime() > Date.now() + 86400000))
      throw new Error('CUTROOM_MAINTENANCE_DATE');
    const id = await boss.send(name, data, { db: fromKysely(trx), ...(startAfter ? { startAfter } : {}) });
    if (id === null) throw new Error('CUTROOM_JOB_NOT_CREATED');
  };
}

import { z } from 'zod';
import type { CutroomAccountingScopeTx, CutroomAccountingWork } from '../../reasoning/public.js';
import { cutroomAccountingTransactionOf } from '../postgres/cutroom-scope.js';
const world = z.enum(['dev', 'stage']);
const base = { v: z.literal(1), worldId: world, attemptId: z.uuid() };
const followWork = z.strictObject({ ...base, businessRunId: z.uuid(), dispatchId: z.uuid() });
const settleWork = z.strictObject({ ...base, businessRunId: z.uuid(), operationId: z.uuid() });
const poolWork = z.strictObject({ ...base, generation: z.number().int().positive(), operationId: z.uuid() });
const worldWork: Readonly<Record<string, z.ZodType<{ v: 1; worldId: 'dev' | 'stage'; attemptId: string }>>> = {
  'reasoning.cutroom-pool': poolWork,
  'reasoning.cutroom-follow': followWork,
  'reasoning.settle-cutroom': settleWork,
};
export type EnqueueCutroomAccounting = (
  scope: CutroomAccountingScopeTx,
  payload: CutroomAccountingWork,
) => Promise<void>;
const accountingWork = z.strictObject({
  v: z.literal(1),
  worldId: z.enum(['dev', 'stage']),
  attemptId: z.uuid(),
  businessRunId: z.uuid(),
  observationId: z.uuid(),
});
/** Fixed queue captured ONLY by trusted composition. A caller supplies no queue or dispatch capability. */
export function makeEnqueueCutroomAccounting(
  boss: PgBoss,
  queue: QueueDefinition<CutroomAccountingWork>,
): EnqueueCutroomAccounting {
  if (queue.name !== 'reasoning.cutroom-accounting') throw new Error('CUTROOM_ACCOUNTING_QUEUE_REQUIRED');
  const queueName = 'reasoning.cutroom-accounting';
  return async (scope, payload) => {
    const trx = cutroomAccountingTransactionOf(scope),
      data = accountingWork.parse(payload);
    if (
      data.worldId !== scope.worldId ||
      data.businessRunId !== scope.businessRunId ||
      data.attemptId !== scope.attemptId
    )
      throw new Error('CUTROOM_ACCOUNTING_SCOPE_MISMATCH');
    const id = await boss.send(queueName, data, { db: fromKysely(trx) });
    if (id === null) throw new Error('CUTROOM_ACCOUNTING_JOB_NOT_CREATED');
  };
}

/** Historical maintenance can wake only exact retained follow/settlement work. No pool
 * claim/dispatch queue is reachable from the accounting capability. */
export function makeEnqueueCutroomMaintenance(boss: PgBoss) {
  return async (
    scope: CutroomAccountingScopeTx,
    input:
      | { readonly kind: 'follow'; readonly payload: z.infer<typeof followWork> }
      | { readonly kind: 'settle'; readonly payload: z.infer<typeof settleWork> },
    startAfter?: Date,
  ) => {
    const trx = cutroomAccountingTransactionOf(scope);
    const data = input.kind === 'follow' ? followWork.parse(input.payload) : settleWork.parse(input.payload);
    if (
      data.worldId !== scope.worldId ||
      data.attemptId !== scope.attemptId ||
      data.businessRunId !== scope.businessRunId
    )
      throw new Error('CUTROOM_MAINTENANCE_BINDING');
    if (startAfter && (!Number.isFinite(startAfter.getTime()) || startAfter.getTime() > Date.now() + 86400000))
      throw new Error('CUTROOM_MAINTENANCE_DATE');
    const matched =
      input.kind === 'follow'
        ? (
            await sql`select 1 from reasoning.cutroom_execution where attempt_id=${scope.attemptId}::uuid and dispatch_id=${input.payload.dispatchId}::uuid`.execute(
              trx,
            )
          ).rows.length === 1
        : (
            await sql`select 1 from reasoning.cutroom_settlements where attempt_id=${scope.attemptId}::uuid and id=${input.payload.operationId}::uuid union all select 1 from reasoning.cutroom_financial_reports where attempt_id=${scope.attemptId}::uuid and id=${input.payload.operationId}::uuid and hold_state in ('pending','recorded')`.execute(
              trx,
            )
          ).rows.length === 1;
    if (!matched) throw new Error('CUTROOM_MAINTENANCE_OPERATION');
    const name = input.kind === 'follow' ? 'reasoning.cutroom-follow' : 'reasoning.settle-cutroom';
    if ((await boss.send(name, data, { db: fromKysely(trx), ...(startAfter ? { startAfter } : {}) })) === null)
      throw new Error('CUTROOM_MAINTENANCE_JOB_REQUIRED');
  };
}
export async function hasLiveCutroomWork(scope: CutroomAccountingScopeTx): Promise<boolean> {
  const r = await sql<{ live: boolean }>`select exists(select 1 from pgboss.job where
    name in ('reasoning.cutroom-pool','reasoning.cutroom-follow','reasoning.cutroom-accounting','reasoning.settle-cutroom')
    and data->>'worldId'=${scope.worldId} and data->>'attemptId'=${scope.attemptId}
    and ((state in ('created','retry') and keep_until>pgboss.job_now())
      or(state='active' and started_on+expire_seconds*interval '1 second'>=pgboss.job_now()
        and(heartbeat_seconds is null or heartbeat_on+heartbeat_seconds*interval '1 second'>=pgboss.job_now())))) live`.execute(
    cutroomAccountingTransactionOf(scope),
  );
  return r.rows[0]?.live === true;
}
const recoveryWork = z
  .strictObject({ v: z.literal(1), afterAttemptId: z.uuid(), throughAttemptId: z.uuid() })
  .refine((v) => v.afterAttemptId < v.throughAttemptId);
/** Bounded IDs-only discovery continuation, never exact-operation effect authority. */
export async function enqueueCutroomRecoveryPage(boss: PgBoss, trx: Transaction<Database>, input: unknown) {
  const data = recoveryWork.parse(input),
    name = 'reasoning.recover-cutroom';
  await sql`select pg_advisory_xact_lock(hashtextextended(${`${name}:${data.afterAttemptId}:${data.throughAttemptId}`},0))`.execute(
    trx,
  );
  const live = (
    await sql<{ live: boolean }>`select exists(select 1 from pgboss.job where name=${name}
    and data->>'afterAttemptId'=${data.afterAttemptId} and data->>'throughAttemptId'=${data.throughAttemptId}
    and ((state in ('created','retry') and keep_until>pgboss.job_now())
      or(state='active' and started_on+expire_seconds*interval '1 second'>=pgboss.job_now()
        and(heartbeat_seconds is null or heartbeat_on+heartbeat_seconds*interval '1 second'>=pgboss.job_now())))) live`.execute(
      trx,
    )
  ).rows[0]?.live;
  if (!live && (await boss.send(name, data, { db: fromKysely(trx) })) === null)
    throw new Error('CUTROOM_RECOVERY_PAGE_REQUIRED');
}
