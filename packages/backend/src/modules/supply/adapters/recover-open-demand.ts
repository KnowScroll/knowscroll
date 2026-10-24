import type { Kysely } from 'kysely';
import type { PgBoss } from 'pg-boss';
import { stableUuid } from '../../../infrastructure/ids/index.js';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { resolveSupplyQueue } from '../events.js';

export interface RecoveredDemand {
  /** Open asks found, by state. */
  readonly open: Readonly<Record<string, number>>;
  readonly queued: number;
  /** Open asks whose recovery job already exists (an earlier run, still retained). */
  readonly alreadyQueued: number;
}

/**
 * The one-time recovery for demand that is still open from before Create existed (D-037): an
 * operator command that sends one resolver job for every ask that is waiting to be matched or
 * produced. The resolver does the rest: it commissions a group that commissioned nothing, binds
 * content that already exists, or closes the ask honestly. The recovery job's ID is stable per
 * request, so running the command twice does not send a second job while the first is retained. Reads
 * the shared table across universes (an operator's view of IDs only) and sends no personal data:
 * the job names the universe, the epoch and the request.
 */
export async function recoverOpenDemand(
  db: Kysely<Database>,
  boss: PgBoss,
  options: { readonly dryRun: boolean },
): Promise<RecoveredDemand> {
  const rows = await db
    .selectFrom('supply.requests')
    .select(['universe_id', 'privacy_epoch', 'id', 'state'])
    .where('state', 'in', ['requested', 'deferred', 'matching'])
    .orderBy('created_at')
    .execute();
  const open: Record<string, number> = {};
  let queued = 0;
  let alreadyQueued = 0;
  for (const row of rows) {
    open[row.state] = (open[row.state] ?? 0) + 1;
    if (options.dryRun) continue;
    const sent = await boss.send(
      resolveSupplyQueue.name,
      resolveSupplyQueue.payload.parse({
        v: 1,
        universeId: row.universe_id,
        privacyEpoch: row.privacy_epoch,
        requestId: row.id,
      }),
      { id: stableUuid(`supply-recover:${row.id}`) },
    );
    if (sent === null) alreadyQueued += 1;
    else queued += 1;
  }
  return { open, queued, alreadyQueued };
}
