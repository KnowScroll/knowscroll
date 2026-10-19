import type { JobResult, PgBoss } from 'pg-boss';
import { sanitiseError } from '../observability/sanitise.js';
import type { LogEvent } from '../observability/index.js';
import type { QueueDefinition } from './queues.js';

/** One pg-boss delivery of a job. Delivery is not permission to repeat a paid external call. */
export interface JobDelivery {
  readonly jobId: string;
  /** 0 on the first delivery; increases on each redelivery after a failure or lost claim. */
  readonly retryCount: number;
  readonly signal: AbortSignal;
}

/**
 * A worker consumer. Consumers are non-transactional: `handle` opens its own short transactions,
 * records its applied identity with its effects so redelivery is harmless, and never holds a
 * transaction across a network call (blueprint §19).
 */
export interface JobConsumer<Payload> {
  readonly queue: QueueDefinition<Payload>;
  handle(payload: Payload, delivery: JobDelivery): Promise<void>;
}

/** Pairs a queue with the use case that handles its jobs (one entry of a worker's registry). */
export function jobConsumer<Payload>(
  queue: QueueDefinition<Payload>,
  handle: (payload: Payload, delivery: JobDelivery) => Promise<void>,
): JobConsumer<Payload> {
  return { queue, handle };
}

/** Raised for a payload that does not match its queue's schema; redelivery cannot fix it. */
export class InvalidJobPayloadError extends Error {
  override readonly name = 'InvalidJobPayloadError';
  readonly code = 'INVALID_JOB_PAYLOAD';
}

/**
 * What pg-boss stores as a failed job's output: a stable code and the error class, never a
 * message, stack, cause or driver detail (D-017). pg-boss keeps job rows for days and dead letters
 * for two weeks; free text there would bypass the no-free-text rule.
 */
export interface JobFailureOutput {
  readonly failure: 'handler_failed' | 'invalid_payload';
  readonly errorClass: string;
  readonly code?: string;
}

/** The code-only failure record of `error` (see {@link JobFailureOutput}). */
export function jobFailureOutput(failure: JobFailureOutput['failure'], error: unknown): JobFailureOutput {
  const sanitised = sanitiseError(error);
  return {
    failure,
    errorClass: sanitised.errorClass,
    ...(sanitised.code === undefined ? {} : { code: sanitised.code }),
  };
}

/**
 * Registers each consumer with pg-boss using the queue's declared consumer policy, settling every
 * job explicitly (pg-boss `perJobResults`):
 * - success → `completed`;
 * - a payload that does not match the queue's schema → `deadletter` at once (redelivery cannot fix
 *   it; it goes to `<queue>.dead` when the queue has one, otherwise fails terminally);
 * - a handler failure → `failed` with a code-only output, retried or dead-lettered by the queue's
 *   policy. The failure is logged once (sanitised, without the payload).
 */
export async function startConsumers(
  boss: PgBoss,
  consumers: readonly JobConsumer<unknown>[],
  logEvent: LogEvent,
): Promise<void> {
  const names = new Set<string>();
  for (const consumer of consumers) {
    const { queue } = consumer;
    if (names.has(queue.name)) throw new Error(`Two consumers for queue ${queue.name}`);
    names.add(queue.name);
    await boss.work<unknown>(
      queue.name,
      {
        batchSize: 1,
        localConcurrency: queue.consumer.localConcurrency,
        pollingIntervalSeconds: queue.consumer.pollingIntervalSeconds,
        perJobResults: true,
      },
      async (jobs) => {
        const results: JobResult[] = [];
        for (const job of jobs) {
          const parsed = queue.payload.safeParse(job.data);
          if (!parsed.success) {
            const error = new InvalidJobPayloadError(`Payload does not match ${queue.name}`);
            logEvent('jobs.job_failed', {
              queue: queue.name,
              jobId: job.id,
              retryCount: job.retryCount,
              reasonCode: 'invalid_payload',
              error,
            });
            results.push({ id: job.id, status: 'deadletter', output: jobFailureOutput('invalid_payload', error) });
            continue;
          }
          try {
            await consumer.handle(parsed.data, { jobId: job.id, retryCount: job.retryCount, signal: job.signal });
            results.push({ id: job.id, status: 'completed' });
          } catch (error) {
            logEvent('jobs.job_failed', {
              queue: queue.name,
              jobId: job.id,
              retryCount: job.retryCount,
              reasonCode: 'handler_failed',
              error,
            });
            results.push({ id: job.id, status: 'failed', output: jobFailureOutput('handler_failed', error) });
          }
        }
        return results;
      },
    );
    logEvent('jobs.consumer_registered', { queue: queue.name, count: queue.consumer.localConcurrency });
  }
}

/** Stops claiming new jobs and waits up to `timeoutMs` for running handlers, then closes pg-boss. */
export async function drainConsumers(
  boss: PgBoss,
  consumerCount: number,
  timeoutMs: number,
  logEvent: LogEvent,
): Promise<void> {
  logEvent('jobs.consumers_draining', { count: consumerCount });
  await boss.stop({ graceful: true, close: true, timeout: timeoutMs });
}
