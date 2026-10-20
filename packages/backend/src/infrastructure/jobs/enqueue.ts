import { fromKysely, type PgBoss } from 'pg-boss';
import type { PersonalScopeTx } from '../../modules/identity/public.js';
import { transactionOf } from '../postgres/personal-scope.js';
import type { QueueDefinition } from './queues.js';

/**
 * The job port: send durable work in the caller's open transaction (blueprint §19 "Durable work
 * and disposable notices"). Requires the transaction capability, so work can only be enqueued
 * together with the state change that needs it; a rollback removes both.
 */
export type EnqueueJob = <Payload>(
  scope: PersonalScopeTx,
  queue: QueueDefinition<Payload>,
  payload: Payload,
  options?: { readonly startAfter: Date },
) => Promise<void>;

/**
 * Creates the job port over a started `producer` pg-boss instance. The payload is validated
 * against the queue schema first. `boss.send(…, { db: fromKysely(trx) })` writes the job through
 * the scope's own transaction, never a fresh connection.
 */
export function makeEnqueueJob(boss: PgBoss): EnqueueJob {
  return async (scope, queue, payload, options) => {
    if (options && !(options.startAfter instanceof Date)) throw new Error('JOB_START_AFTER_INVALID');
    const startAfter = options ? new Date(options.startAfter.getTime()) : undefined;
    if (startAfter && (!Number.isFinite(startAfter.getTime()) || startAfter.getTime() > Date.now() + 86400000))
      throw new Error('JOB_START_AFTER_INVALID');
    const data = queue.payload.parse(payload) as object;
    const id = await boss.send(queue.name, data, {
      db: fromKysely(transactionOf(scope)),
      ...(startAfter ? { startAfter } : {}),
    });
    if (id === null) throw new Error(`pg-boss did not create a job on ${queue.name}`);
  };
}
