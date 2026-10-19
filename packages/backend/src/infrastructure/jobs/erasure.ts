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
