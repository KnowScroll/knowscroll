import { fromKysely, type PgBoss } from 'pg-boss';
import { sql, type Transaction } from 'kysely';
import type { Database } from '../postgres/database.js';
import { z } from 'zod';
import { cutroomReceiveTransactionOf } from '../postgres/cutroom-receive-scope.js';
const workSchema = z.strictObject({ v: z.literal(1), worldId: z.enum(['dev', 'stage']), handoffId: z.uuid() });
const recoverySchema = z
  .strictObject({ v: z.literal(1), worldId: z.enum(['dev', 'stage']), afterId: z.uuid(), throughId: z.uuid() })
  .refine((v) => v.afterId < v.throughId);
/** No queue callback or name is supplied by callers; fixed receiving queues only. */
export function makeEnqueueCutroomReceive(boss: PgBoss) {
  return async (scope: object, input: { readonly kind: 'receive' | 'recover'; readonly payload: unknown }) => {
    const parsed = input.kind === 'receive' ? workSchema.parse(input.payload) : recoverySchema.parse(input.payload);
    const trx = cutroomReceiveTransactionOf(scope);
    const name = input.kind === 'receive' ? 'content.receive-cutroom' : 'content.recover-receive-cutroom';
    if ((await boss.send(name, parsed, { db: fromKysely(trx) })) === null)
      throw new Error('CUTROOM_RECEIVE_JOB_REQUIRED');
  };
}
export async function hasLiveReceiveWork(scope: object, world: string, handoffId: string): Promise<boolean> {
  return (
    (
      await sql<{
        live: boolean;
      }>`select exists(select 1 from pgboss.job where name='content.receive-cutroom' and data->>'worldId'=${world} and data->>'handoffId'=${handoffId}
    and ((state in ('created','retry') and keep_until>pgboss.job_now()) or (state='active' and started_on+expire_seconds*interval '1 second'>=pgboss.job_now() and (heartbeat_seconds is null or heartbeat_on+heartbeat_seconds*interval '1 second'>=pgboss.job_now())))) live`.execute(
        cutroomReceiveTransactionOf(scope),
      )
    ).rows[0]?.live === true
  );
}
/** Fixed discovery continuation commits before operation locks, deduplicated only while live. */
export async function enqueueReceiveRecoveryPage(
  boss: PgBoss,
  trx: Transaction<Database>,
  input: unknown,
): Promise<void> {
  const data = recoverySchema.parse(input);
  await sql`select pg_advisory_xact_lock(hashtextextended(${`content.receive-page:${data.worldId}:${data.afterId}:${data.throughId}`},0))`.execute(
    trx,
  );
  const live = (
    await sql<{
      live: boolean;
    }>`select exists(select 1 from pgboss.job where name='content.recover-receive-cutroom' and data->>'worldId'=${data.worldId} and data->>'afterId'=${data.afterId} and data->>'throughId'=${data.throughId}
    and ((state in ('created','retry') and keep_until>pgboss.job_now()) or(state='active' and started_on+expire_seconds*interval '1 second'>=pgboss.job_now() and(heartbeat_seconds is null or heartbeat_on+heartbeat_seconds*interval '1 second'>=pgboss.job_now())))) live`.execute(
      trx,
    )
  ).rows[0]?.live;
  if (!live && (await boss.send('content.recover-receive-cutroom', data, { db: fromKysely(trx) })) === null)
    throw new Error('CUTROOM_RECEIVE_PAGE_REQUIRED');
}
