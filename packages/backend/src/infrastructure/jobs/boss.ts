import { PgBoss, type Queue } from 'pg-boss';
import type { DatabaseSettings } from '../config/index.js';
import type { LogEvent } from '../observability/index.js';
import { DEAD_LETTER_RETENTION_SECONDS, JOB_SCHEMA, deadLetterQueueName, type QueueDefinition } from './queues.js';

/**
 * What a pg-boss instance is for:
 * - `install`: the migrate command; creates or upgrades pg-boss's schema and the declared queues.
 * - `producer`: the API; sends jobs inside our transactions, never claims work or runs maintenance.
 * - `consumer`: the worker; claims work and runs pg-boss maintenance. It never changes the schema.
 */
export type BossRole = 'install' | 'producer' | 'consumer';

/** Errors and warnings pg-boss emits, forwarded to the caller's diagnostics. */
export interface BossDiagnostics {
  onError(error: unknown): void;
  /** pg-boss warning kinds (`slow_query`, `large_queue`, …); warning text is never forwarded. */
  onWarning(reasonCode: string): void;
}

/**
 * Creates (but does not start) a pg-boss instance with its own small pool. pg-boss never shares
 * the Kysely pool: transactional sends pass the current transaction explicitly instead.
 */
export function createBoss(settings: DatabaseSettings, role: BossRole, diagnostics: BossDiagnostics): PgBoss {
  const boss = new PgBoss({
    connectionString: settings.url,
    application_name: `${settings.applicationName}-jobs`,
    schema: JOB_SCHEMA,
    max: role === 'consumer' ? Math.max(2, settings.poolMax) : 2,
    // An unreachable database fails start() instead of hanging it.
    connectionTimeoutMillis: 10_000,
    migrate: role === 'install',
    createSchema: role === 'install',
    supervise: role === 'consumer',
    // Only the worker sends scheduled jobs (declared queues' `schedule`, registered by migrate).
    schedule: role === 'consumer',
  });
  boss.on('error', (error) => diagnostics.onError(error));
  boss.on('warning', (warning: { readonly data?: { readonly type?: unknown } }) => {
    const type = warning.data?.type;
    diagnostics.onWarning(typeof type === 'string' && /^[a-z_]{1,40}$/.test(type) ? type : 'warning');
  });
  return boss;
}

/**
 * Creates every declared queue (and its dead-letter queue) or brings an existing queue's policy
 * in line with its declaration, and registers (or removes) its recurring schedule. Run by the
 * migrate command with an `install` instance. Idempotent. Queue policy changes apply to jobs sent
 * afterwards.
 */
export async function applyQueueDeclarations(boss: PgBoss, queues: readonly QueueDefinition<unknown>[]): Promise<void> {
  for (const queue of queues) {
    if (queue.policy.deadLetter) {
      const dead = deadLetterQueueName(queue.name);
      const deadOptions = {
        retryLimit: 0,
        retentionSeconds: DEAD_LETTER_RETENTION_SECONDS,
        deleteAfterSeconds: DEAD_LETTER_RETENTION_SECONDS,
      };
      if ((await boss.getQueue(dead)) === null) await boss.createQueue(dead, { policy: 'standard', ...deadOptions });
      else await boss.updateQueue(dead, deadOptions);
    }
    const options: Omit<Queue, 'name' | 'policy' | 'partition' | 'deadLetter'> = {
      expireInSeconds: queue.policy.expireInSeconds,
      retryLimit: queue.policy.retryLimit,
      retryDelay: queue.policy.retryDelaySeconds,
      retryBackoff: queue.policy.retryBackoff,
      retentionSeconds: queue.policy.retentionSeconds,
      deleteAfterSeconds: queue.policy.deleteAfterSeconds,
    };
    const deadLetter = queue.policy.deadLetter ? deadLetterQueueName(queue.name) : undefined;
    if ((await boss.getQueue(queue.name)) === null) {
      await boss.createQueue(queue.name, {
        policy: queue.exclusive === true ? 'exclusive' : 'standard',
        ...options,
        ...(deadLetter === undefined ? {} : { deadLetter }),
      });
    } else {
      await boss.updateQueue(queue.name, { ...options, deadLetter: deadLetter ?? null });
    }
    // Upserts the recurring job (pg-boss keys it by queue name); a queue without one has none.
    if (queue.schedule === undefined) await boss.unschedule(queue.name);
    else await boss.schedule(queue.name, queue.schedule.cron, queue.schedule.payload as object, { tz: 'UTC' });
  }
}

/**
 * Removes the recurring schedule of every queue the release no longer declares.
 *
 * Purpose: `applyQueueDeclarations` registers a schedule only for the queues in the registry, but a
 * queue that leaves the registry keeps its schedule row, and pg-boss goes on creating jobs that no
 * consumer claims. The worker calls this at startup, after it registered its consumers, with the
 * release's explicit queue registry.
 *
 * Inputs: a started pg-boss instance and the registry. Output: the schedules removed, as
 * `{ queue, key }`. A schedule is kept when its queue name is in the registry, whatever its key.
 * Authority: none; schedules are release configuration, not personal data. Side effects: deletes
 * schedule rows and logs `jobs.schedule_removed` once per removal with the queue name.
 *
 * Failure/retry: idempotent. Workers that start together may race; the second delete finds nothing.
 * A database error propagates and fails startup, and the restart tries again. The queue and the jobs
 * it already holds are left alone.
 */
export async function removeUndeclaredSchedules(
  boss: PgBoss,
  declared: readonly QueueDefinition<unknown>[],
  logEvent: LogEvent,
): Promise<readonly { readonly queue: string; readonly key: string }[]> {
  const declaredNames = new Set(declared.map((queue) => queue.name));
  const removed: { readonly queue: string; readonly key: string }[] = [];
  for (const schedule of await boss.getSchedules()) {
    if (declaredNames.has(schedule.name)) continue;
    await boss.unschedule(schedule.name, schedule.key);
    removed.push({ queue: schedule.name, key: schedule.key });
    logEvent('jobs.schedule_removed', { queue: schedule.name });
  }
  return removed;
}
