import { fromKysely, type PgBoss } from 'pg-boss';
import { z } from 'zod';
import type { ClearAccountingTx, PrivacyScopeTx, ClearExplorationJob } from '../../modules/identity/public.js';
import { privacyTransactionOf, privacyOperationOf, clearAccountingTransactionOf } from '../postgres/privacy-scope.js';
import type { QueueDefinition } from './queues.js';
const queueName = 'identity.clear-exploration';
const payloadSchema = z.strictObject({ v: z.literal(1), accountId: z.uuid(), commandId: z.uuid() });
/** Fixed queue and exact stored operation only. Accounting cannot dispatch or wake another clear. */
export function makeEnqueuePrivacyJob(boss: PgBoss, queue: QueueDefinition<ClearExplorationJob>) {
  if (queue.name !== queueName) throw new Error('PRIVACY_QUEUE_INVALID');
  return async (
    scope: PrivacyScopeTx | ClearAccountingTx,
    payload: ClearExplorationJob,
    startAfter?: Date,
  ): Promise<void> => {
    const accounting = 'liabilities' in scope;
    const trx = accounting ? clearAccountingTransactionOf(scope) : privacyTransactionOf(scope);
    const binding = accounting ? scope.binding : privacyOperationOf(scope);
    const data = payloadSchema.parse(payload);
    if (data.accountId !== binding.accountId || data.commandId !== binding.commandId)
      throw new Error('PRIVACY_JOB_BINDING_INVALID');
    if (startAfter && (!Number.isFinite(startAfter.getTime()) || startAfter.getTime() > Date.now() + 86400000))
      throw new Error('PRIVACY_JOB_DATE_INVALID');
    const id = await boss.send(queueName, data, { db: fromKysely(trx), ...(startAfter ? { startAfter } : {}) });
    if (id === null) throw new Error('PRIVACY_JOB_REQUIRED');
  };
}
