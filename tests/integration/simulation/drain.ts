import type { PgBoss } from 'pg-boss';
import { sql } from 'kysely';
import { jobFailureOutput, type JobConsumer } from '@knowscroll/backend/infrastructure/jobs';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import type { Kysely } from 'kysely';

/** What one `drain` did: jobs handled per queue, failures, and how many rounds it took. */
export interface DrainReport {
  readonly rounds: number;
  readonly handled: Readonly<Record<string, number>>;
  /** Handler failures seen (a retried job that fails again counts again). */
  readonly failures: Readonly<Record<string, number>>;
  /** The first few distinct messages of the errors handlers threw, per queue (codes, never payloads). */
  readonly errors: Readonly<Record<string, readonly string[]>>;
  /** Wall time per queue, milliseconds, for the report. */
  readonly millis: Readonly<Record<string, number>>;
  /** True when the loop stopped because it reached `maxRounds`, not because every queue was idle. */
  readonly exhausted: boolean;
}

export interface DrainOptions {
  /** Upper bound on rounds; a round visits every queue once. */
  readonly maxRounds?: number;
  /** Jobs fetched per queue per visit. */
  readonly batchSize?: number;
}

/**
 * Runs the worker's consumers until every queue is idle, the way `startConsumers` would, but in one
 * process and in a fixed order, so a lab run is repeatable.
 *
 * Each job is claimed with `boss.fetch`, parsed against its queue's payload schema, handled, and
 * settled like the worker settles it: `complete` on success, `fail` with the code-only output on a
 * throw (pg-boss then retries or dead-letters it by the queue's own policy). A job whose retry or
 * `startAfter` lies in the future is made due first: this is the lab's virtual clock. It skips the
 * waiting (a 30 second Geography pacing, a retry delay), never the work.
 */
export async function drain(
  boss: PgBoss,
  db: Kysely<Database>,
  consumers: readonly JobConsumer<unknown>[],
  options: DrainOptions = {},
): Promise<DrainReport> {
  const maxRounds = options.maxRounds ?? 60;
  const batchSize = options.batchSize ?? 10;
  const handled: Record<string, number> = {};
  const failures: Record<string, number> = {};
  const errors: Record<string, string[]> = {};
  const millis: Record<string, number> = {};
  const names = consumers.map((consumer) => consumer.queue.name);
  let rounds = 0;
  let progressed = true;
  while (progressed && rounds < maxRounds) {
    progressed = false;
    rounds += 1;
    await sql`update pgboss.job set start_after = now()
      where name = any(${names}) and state in ('created', 'retry') and start_after > now()`.execute(db);
    // One query says which queues have work, so an idle queue costs nothing.
    const waiting = new Set(
      (
        await sql<{ name: string }>`select distinct name from pgboss.job
          where name = any(${names}) and state in ('created', 'retry')`.execute(db)
      ).rows.map((row) => row.name),
    );
    for (const consumer of consumers) {
      const { queue } = consumer;
      if (!waiting.has(queue.name)) continue;
      const jobs = await boss.fetch<unknown>(queue.name, { batchSize, includeMetadata: true });
      for (const job of jobs) {
        progressed = true;
        const startedAt = performance.now();
        const parsed = queue.payload.safeParse(job.data);
        try {
          if (!parsed.success) throw new Error(`Payload does not match ${queue.name}`);
          await consumer.handle(parsed.data, {
            jobId: job.id,
            retryCount: job.retryCount,
            signal: new AbortController().signal,
          });
          await boss.complete(queue.name, job.id);
        } catch (error) {
          failures[queue.name] = (failures[queue.name] ?? 0) + 1;
          const message = error instanceof Error ? error.message.slice(0, 160) : 'non-error thrown';
          const seen = (errors[queue.name] ??= []);
          if (seen.length < 3 && !seen.includes(message)) seen.push(message);
          await boss.fail(
            queue.name,
            job.id,
            jobFailureOutput(parsed.success ? 'handler_failed' : 'invalid_payload', error),
          );
        }
        handled[queue.name] = (handled[queue.name] ?? 0) + 1;
        millis[queue.name] = (millis[queue.name] ?? 0) + (performance.now() - startedAt);
      }
    }
  }
  return { rounds, handled, failures, errors, millis, exhausted: progressed };
}

/** Adds one report to another, for a persona that drains after every encounter. */
export function addReports(total: DrainReport, next: DrainReport): DrainReport {
  const add = (a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>) => {
    const sum: Record<string, number> = { ...a };
    for (const [key, value] of Object.entries(b)) sum[key] = (sum[key] ?? 0) + value;
    return sum;
  };
  return {
    rounds: total.rounds + next.rounds,
    handled: add(total.handled, next.handled),
    failures: add(total.failures, next.failures),
    errors: mergeErrors(total.errors, next.errors),
    millis: add(total.millis, next.millis),
    exhausted: total.exhausted || next.exhausted,
  };
}

function mergeErrors(a: Readonly<Record<string, readonly string[]>>, b: Readonly<Record<string, readonly string[]>>) {
  const merged: Record<string, string[]> = {};
  for (const source of [a, b])
    for (const [queue, messages] of Object.entries(source)) {
      const into = (merged[queue] ??= []);
      for (const message of messages) if (into.length < 3 && !into.includes(message)) into.push(message);
    }
  return merged;
}

export const emptyReport: DrainReport = {
  rounds: 0,
  handled: {},
  failures: {},
  errors: {},
  millis: {},
  exhausted: false,
};
