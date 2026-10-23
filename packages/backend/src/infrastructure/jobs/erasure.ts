import type { ClearCoreTx } from '../../modules/identity/public.js';
import { clearCoreTransactionOf } from '../postgres/privacy-scope.js';
import { sql } from 'kysely';
import type { PersonalScopeTx } from '../../modules/identity/public.js';
import { transactionOf } from '../postgres/personal-scope.js';
import { JOB_SCHEMA, deadLetterQueueName } from './queues.js';

/**
 * Deletes the scope universe's job payloads (queued, active, retained and dead-lettered) from the
 * named queues, inside the erasing transaction. Queue payloads are IDs only, but IDs are still
 * personal metadata (blueprint §5, §26). Returns the number of jobs removed.
 */
export async function deleteJobPayloads(scope: PersonalScopeTx, queues: readonly string[]): Promise<number> {
  const names = queues.flatMap((queue) => [queue, deadLetterQueueName(queue)]);
  const result =
    await sql`delete from ${sql.table(`${JOB_SCHEMA}.job`)} where name = any(${names}::text[]) and data ->> 'universeId' = ${scope.authority.universeId}`.execute(
      transactionOf(scope),
    );
  return Number(result.numAffectedRows ?? 0n);
}

/** Only a live core capability can erase old exploration queue payloads. */
export async function deleteClearJobPayloads(scope: ClearCoreTx, queues: readonly string[]): Promise<number> {
  const trx = clearCoreTransactionOf(scope);
  const names = queues.flatMap((q) => [q, deadLetterQueueName(q)]);
  const result = await sql`delete from ${sql.table(`${JOB_SCHEMA}.job`)}
 where name = any(${names}::text[]) and data ->> 'universeId' = ${scope.binding.universeId}`.execute(trx);
  return Number(result.numAffectedRows ?? 0n);
}
