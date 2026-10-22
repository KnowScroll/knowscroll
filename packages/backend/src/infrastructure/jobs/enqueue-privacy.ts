import { fromKysely, type PgBoss } from 'pg-boss';
import { z } from 'zod';
import { sql } from 'kysely';
import { JOB_SCHEMA } from './queues.js';
import type {
  ClearAccountingTx,
  ClearCoreTx,
  PrivacyScopeTx,
  ClearExplorationJob,
} from '../../modules/identity/public.js';
import {
  privacyTransactionOf,
  privacyOperationOf,
  clearAccountingTransactionOf,
  clearCoreTransactionOf,
} from '../postgres/privacy-scope.js';
import type { QueueDefinition } from './queues.js';
const queueName = 'identity.clear-exploration';
const payloadSchema = z.strictObject({ v: z.literal(1), accountId: z.uuid(), commandId: z.uuid() });
/** Fixed queue and exact stored operation only. Accounting cannot dispatch or wake another clear. */
export function makeEnqueuePrivacyJob(boss: PgBoss, queue: QueueDefinition<ClearExplorationJob>) {
  if (queue.name !== queueName) throw new Error('PRIVACY_QUEUE_INVALID');
  return async (
    scope: PrivacyScopeTx | ClearCoreTx | ClearAccountingTx,
    payload: ClearExplorationJob,
    startAfter?: Date,
  ): Promise<void> => {
    const personal = 'authority' in scope;
    const trx = personal
      ? privacyTransactionOf(scope)
      : 'liabilities' in scope
        ? clearAccountingTransactionOf(scope)
        : clearCoreTransactionOf(scope);
    const binding = personal ? privacyOperationOf(scope) : scope.binding;
    const data = payloadSchema.parse(payload);
    if (data.accountId !== binding.accountId || data.commandId !== binding.commandId)
      throw new Error('PRIVACY_JOB_BINDING_INVALID');
    if (startAfter && (!Number.isFinite(startAfter.getTime()) || startAfter.getTime() > Date.now() + 86400000))
      throw new Error('PRIVACY_JOB_DATE_INVALID');
    const id = await boss.send(queueName, data, { db: fromKysely(trx), ...(startAfter ? { startAfter } : {}) });
    if (id === null) throw new Error('PRIVACY_JOB_REQUIRED');
  };
}

/** Read only the fixed operation's live delivery state while its root/operation locks are held. */
export async function hasLivePrivacyJob(scope: ClearCoreTx | ClearAccountingTx): Promise<boolean> {
  const trx = 'liabilities' in scope ? clearAccountingTransactionOf(scope) : clearCoreTransactionOf(scope);
  const b = scope.binding;
  const result = await sql<{ live: boolean }>`select exists(select 1 from ${sql.table(`${JOB_SCHEMA}.job`)}
  where name=${queueName} and data->>'v'='1'
  and ((state in ('created','retry') and keep_until>pgboss.job_now())
    or (state='active' and started_on+expire_seconds*interval '1 second'>=pgboss.job_now()
      and (heartbeat_seconds is null or heartbeat_on+heartbeat_seconds*interval '1 second'>=pgboss.job_now())))
  and data->>'accountId'=${b.accountId} and data->>'commandId'=${b.commandId}) as live`.execute(trx);
  return result.rows[0]?.live === true;
}
