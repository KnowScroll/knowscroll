import type { PgBoss } from 'pg-boss';
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
 * Registers each consumer with pg-boss using the queue's declared consumer policy. A handler
 * failure is logged once (sanitised, without the payload) and rethrown so pg-boss records the
 * failed delivery and retries or dead-letters it by the queue's policy.
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
      },
      async (jobs) => {
        for (const job of jobs) {
          try {
            const parsed = queue.payload.safeParse(job.data);
            if (!parsed.success) throw new InvalidJobPayloadError(`Payload does not match ${queue.name}`);
            await consumer.handle(parsed.data, { jobId: job.id, retryCount: job.retryCount, signal: job.signal });
          } catch (error) {
            logEvent('jobs.job_failed', { queue: queue.name, jobId: job.id, retryCount: job.retryCount, error });
            throw error;
          }
        }
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
