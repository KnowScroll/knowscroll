import { fromKysely, type PgBoss } from 'pg-boss';
import type { CutroomScopeTx } from '../../reasoning/public.js';
import { cutroomTransactionOf } from '../postgres/cutroom-scope.js';
import type { QueueDefinition } from './queues.js';
export type EnqueueCutroom = <T>(scope: CutroomScopeTx, queue: QueueDefinition<T>, payload: T) => Promise<void>;
/** Same live world transaction, never a PersonalScopeTx cast or a second outbox. */
export function makeEnqueueCutroom(boss: PgBoss): EnqueueCutroom {
  return async (scope, queue, payload) => {
    const trx = cutroomTransactionOf(scope);
    const data = queue.payload.parse(payload) as object;
    const id = await boss.send(queue.name, data, { db: fromKysely(trx) });
    if (id === null) throw new Error('CUTROOM_JOB_NOT_CREATED');
  };
}
