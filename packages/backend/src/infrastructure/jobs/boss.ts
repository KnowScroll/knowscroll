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
    schedule: false,
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
 * in line with its declaration. Run by the migrate command with an `install` instance.
 * Idempotent. Queue policy changes apply to jobs sent afterwards.
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
        policy: 'standard',
        ...options,
        ...(deadLetter === undefined ? {} : { deadLetter }),
      });
    } else {
      await boss.updateQueue(queue.name, { ...options, deadLetter: deadLetter ?? null });
    }
  }
}
