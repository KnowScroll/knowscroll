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

import { z } from 'zod';
import type { CutroomAccountingScopeTx, CutroomAccountingWork } from '../../reasoning/public.js';
import { cutroomAccountingTransactionOf } from '../postgres/cutroom-scope.js';
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
    queue.payload.parse(data);
    const id = await boss.send(queueName, data, { db: fromKysely(trx) });
    if (id === null) throw new Error('CUTROOM_ACCOUNTING_JOB_NOT_CREATED');
  };
}
