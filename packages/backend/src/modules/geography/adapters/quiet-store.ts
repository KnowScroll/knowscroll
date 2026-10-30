import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { withTransaction } from '../../../infrastructure/postgres/personal-scope.js';
import type { EnqueueInTransaction } from '../../../infrastructure/jobs/enqueue.js';
import type { QuietSweepStore } from '../application/quiet.js';
import { settleQuietQueue } from '../events.js';

interface DueUniverse {
  readonly universeId: string;
  readonly privacyEpoch: number;
  readonly recordingGeneration: number | null;
  readonly settleable: boolean;
}

/**
 * The sweep's one query (D-104, D-105). It takes the first `limit` states whose `next_quiet_at` has
 * passed, oldest first, through the partial index `geography_state_quiet_due`, and classifies each:
 * settleable when no Cartographer run holds it, the account is active, nothing is being cleared and
 * recording is on. A settleable universe gets a settle job and a short lease; any other is parked a
 * day ahead. Either way it leaves the head of the index, so one pass reads at most `limit` rows
 * however many universes are refused, and the head is always settleable. A paused universe is left
 * exactly as it was except for this scheduling time.
 *
 * It holds no personal root, so it only reads and writes the state row, skips rows another
 * transaction holds, and leaves every decision to the settle's own authority recheck.
 */
export function quietSweepStore(deps: {
  readonly db: Kysely<Database>;
  readonly enqueueInTransaction: EnqueueInTransaction;
}): QuietSweepStore {
  return {
    handOverDue: ({ now, limit, leaseUntil, parkUntil }) =>
      withTransaction(deps.db, 'geography.sweep-quiet', async (trx) => {
        await sql`select set_config('statement_timeout','5000ms',true),set_config('lock_timeout','250ms',true)`.execute(
          trx,
        );
        const due = await sql<DueUniverse>`
          select s.universe_id as "universeId", s.privacy_epoch as "privacyEpoch",
            u.recording_generation as "recordingGeneration",
            coalesce(s.active_run_id is null and u.status = 'active' and a.status = 'active'
              and u.clear_operation_id is null and u.recording_on, false) as "settleable"
          from geography.state s
          left join identity.universes u on u.id = s.universe_id and u.privacy_epoch = s.privacy_epoch
          left join identity.accounts a on a.id = u.account_id
          where s.next_quiet_at <= ${now.toISOString()}::timestamptz
          order by s.next_quiet_at
          limit ${limit}
          for update of s skip locked`.execute(trx);
        let handedOver = 0;
        for (const universe of due.rows) {
          const settleable = universe.settleable && universe.recordingGeneration !== null;
          if (settleable) {
            await deps.enqueueInTransaction(trx, settleQuietQueue, {
              v: 1,
              universeId: universe.universeId,
              privacyEpoch: universe.privacyEpoch,
              recordingGeneration: universe.recordingGeneration,
            });
            handedOver += 1;
          }
          // The settle rewrites a lease. A parked time stands until the sweep looks again; a run's
          // apply rewrites it sooner. If a settle job is lost, the sweep finds the universe when the
          // lease ends.
          await sql`update geography.state
            set next_quiet_at = ${(settleable ? leaseUntil : parkUntil).toISOString()}::timestamptz
            where universe_id = ${universe.universeId}::uuid and privacy_epoch = ${universe.privacyEpoch}`.execute(trx);
        }
        return handedOver;
      }),
  };
}
