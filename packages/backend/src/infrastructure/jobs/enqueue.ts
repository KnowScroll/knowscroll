import { fromKysely, type PgBoss } from 'pg-boss';
import { z } from 'zod';
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
  options?: { readonly startAfter?: Date; readonly jobId?: string },
) => Promise<void>;

/**
 * Creates the job port over a started `producer` pg-boss instance. The payload is validated
 * against the queue schema first. `boss.send(…, { db: fromKysely(trx) })` writes the job through
 * the scope's own transaction, never a fresh connection.
 */
export function makeEnqueueJob(boss: PgBoss): EnqueueJob {
  return async (scope, queue, payload, options) => {
    // Snapshot only literal data before awaiting; explicit undefined and accessors never turn
    // into an omitted scheduling/identity fence. These options are internal server metadata.
    let startAfter: Date | undefined;
    let jobId: string | undefined;
    if (options !== undefined) {
      let fields: PropertyDescriptorMap;
      try {
        if (
          options === null ||
          (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)
        )
          throw new Error('JOB_OPTIONS_INVALID');
        fields = Object.getOwnPropertyDescriptors(options);
        if (Reflect.ownKeys(fields).some((key) => key !== 'startAfter' && key !== 'jobId'))
          throw new Error('JOB_OPTIONS_INVALID');
        if (Object.values(fields).some((field) => !('value' in field) || !field.enumerable))
          throw new Error('JOB_OPTIONS_INVALID');
      } catch {
        throw new Error('JOB_OPTIONS_INVALID');
      }
      if (fields.startAfter) {
        const value: unknown = fields.startAfter.value;
        let millis: number;
        try {
          if (!(value instanceof Date)) throw new Error('JOB_START_AFTER_INVALID');
          millis = Date.prototype.getTime.call(value);
        } catch {
          throw new Error('JOB_START_AFTER_INVALID');
        }
        if (!Number.isFinite(millis) || millis > Date.now() + 86400000) throw new Error('JOB_START_AFTER_INVALID');
        startAfter = new Date(millis);
      }
      if (fields.jobId) {
        const value: unknown = fields.jobId.value;
        if (typeof value !== 'string' || !z.uuid().safeParse(value).success || value !== value.toLowerCase())
          throw new Error('JOB_ID_INVALID');
        jobId = value;
      }
    }
    const data = queue.payload.parse(payload) as object;
    const id = await boss.send(queue.name, data, {
      db: fromKysely(transactionOf(scope)),
      ...(startAfter ? { startAfter } : {}),
      ...(jobId ? { id: jobId } : {}),
    });
    if (id === null) throw new Error(`pg-boss did not create a job on ${queue.name}`);
    if (jobId !== undefined && id !== jobId) throw new Error('JOB_ID_MISMATCH');
  };
}
