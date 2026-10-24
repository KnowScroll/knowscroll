import { PgBoss, type Queue } from 'pg-boss';
import type { DatabaseSettings } from '../config/index.js';
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
 * Makes pg-boss match the release's queue declarations: creates every declared queue (and its
 * dead-letter queue) or brings an existing queue's policy in line with its declaration, registers
 * or removes each queue's recurring schedule, and removes the schedule of any queue that is no
 * longer declared. The one owner of schedules: the migrate command runs it, with an `install`
 * instance, once per deploy while the old release is quiesced.
 *
 * `queues` must be the complete registry: a schedule whose queue is missing from it is removed.
 * Returns the schedules removed for that reason so the caller can log them. Idempotent; a second
 * run removes nothing. Queue policy changes apply to jobs sent afterwards. A database error
 * propagates and fails the migrate, which the deploy tool reports before the new release starts.
 */
export async function applyQueueDeclarations(
  boss: PgBoss,
  queues: readonly QueueDefinition<unknown>[],
): Promise<readonly RemovedSchedule[]> {
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
  return removeUndeclaredSchedules(boss, queues);
}

/** A recurring schedule `applyQueueDeclarations` removed because no declared queue owns it. */
export interface RemovedSchedule {
  readonly queue: string;
  readonly key: string;
}

/**
 * Deletes every pg-boss schedule whose queue is not declared. A queue that leaves the registry
 * keeps its schedule row, and pg-boss goes on creating jobs that no consumer claims. A schedule is
 * kept when its queue name is declared, whatever its key. The queue and its existing jobs are left
 * alone.
 */
async function removeUndeclaredSchedules(
  boss: PgBoss,
  declared: readonly QueueDefinition<unknown>[],
): Promise<readonly RemovedSchedule[]> {
  const declaredNames = new Set(declared.map((queue) => queue.name));
  const removed: RemovedSchedule[] = [];
  for (const schedule of await boss.getSchedules()) {
    if (declaredNames.has(schedule.name)) continue;
    await boss.unschedule(schedule.name, schedule.key);
    removed.push({ queue: schedule.name, key: schedule.key });
  }
  return removed;
}
