import type { z } from 'zod';

/** PostgreSQL schema that holds pg-boss's own tables. Owned by this adapter. */
export const JOB_SCHEMA = 'pgboss';

/**
 * Delivery policy of one queue, declared next to the queue rather than inherited from pg-boss
 * defaults. Queue retention is delivery bookkeeping, not product history or audit retention.
 */
export interface QueuePolicy {
  /** Seconds a claimed job may run before pg-boss treats the claim as lost and retries it. */
  readonly expireInSeconds: number;
  /** Deliveries after the first. Paid work still consults its attempt ledger on every delivery. */
  readonly retryLimit: number;
  readonly retryDelaySeconds: number;
  readonly retryBackoff: boolean;
  /** Seconds a job may wait in created/retry state before pg-boss deletes it. */
  readonly retentionSeconds: number;
  /** Seconds a completed or failed job is kept before deletion. */
  readonly deleteAfterSeconds: number;
  /** Whether jobs that exhaust their retries are copied to `<name>.dead` for inspection. */
  readonly deadLetter: boolean;
}

/** How a worker process consumes one queue. */
export interface ConsumerPolicy {
  /** Handlers running at once for this queue in one worker process. */
  readonly localConcurrency: number;
  readonly pollingIntervalSeconds: number;
}

/**
 * One durable work queue. The payload schema is versioned (`v`) and carries IDs only: no prompts,
 * message bodies or other private content (blueprint §19).
 */
export interface QueueDefinition<Payload> {
  readonly name: string;
  readonly purpose: string;
  readonly payload: z.ZodType<Payload>;
  readonly policy: QueuePolicy;
  readonly consumer: ConsumerPolicy;
}

const queueNamePattern = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;

/** Declares a queue; names are `<module>.<operation>` so ownership is visible in pg-boss tables. */
export function defineQueue<Payload>(definition: QueueDefinition<Payload>): QueueDefinition<Payload> {
  if (!queueNamePattern.test(definition.name)) {
    throw new Error(`Queue name must be <module>.<operation> in lowercase: ${definition.name}`);
  }
  return definition;
}

/** Name of the dead-letter queue paired with `queue`. */
export function deadLetterQueueName(queue: string): string {
  return `${queue}.dead`;
}

/** Retention of dead-letter queues: long enough to inspect, bounded so payload IDs expire. */
export const DEAD_LETTER_RETENTION_SECONDS = 14 * 24 * 60 * 60;

/** A process's complete, explicit list of queues. Duplicate names are refused. */
export function queueRegistry(queues: readonly QueueDefinition<unknown>[]): readonly QueueDefinition<unknown>[] {
  const names = new Set<string>();
  for (const queue of queues) {
    if (names.has(queue.name)) throw new Error(`Queue registered twice: ${queue.name}`);
    names.add(queue.name);
  }
  return queues;
}
