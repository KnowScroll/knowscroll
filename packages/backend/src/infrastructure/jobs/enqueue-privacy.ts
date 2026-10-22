import { fromKysely, type PgBoss } from 'pg-boss';
import type { ClearAccountingTx, PrivacyScopeTx } from '../../modules/identity/public.js';
import { privacyTransactionOf, clearAccountingTransactionOf } from '../postgres/privacy-scope.js';
import type { QueueDefinition } from './queues.js';
/** Fixed trusted queue captured by composition. No PersonalScope cast or caller-selected queue. */
export function makeEnqueuePrivacyJob<P extends object>(boss: PgBoss, queue: QueueDefinition<P>) {
  return async (scope: PrivacyScopeTx | ClearAccountingTx, payload: P, startAfter?: Date): Promise<void> => {
    const trx = 'liabilities' in scope ? clearAccountingTransactionOf(scope) : privacyTransactionOf(scope);
    const data = queue.payload.parse(payload);
    if (startAfter && (!Number.isFinite(startAfter.getTime()) || startAfter.getTime() > Date.now() + 86400000))
      throw new Error('PRIVACY_JOB_DATE_INVALID');
    const id = await boss.send(queue.name, data, { db: fromKysely(trx), ...(startAfter ? { startAfter } : {}) });
    if (id === null) throw new Error('PRIVACY_JOB_REQUIRED');
  };
}
