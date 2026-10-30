import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { withTransaction } from '../../../infrastructure/postgres/personal-scope.js';
import type { EnqueueInTransaction } from '../../../infrastructure/jobs/enqueue.js';
import type { QuietSweepStore } from '../application/quiet.js';
import { settleQuietQueue } from '../events.js';

interface DueUniverse {
  readonly universeId: string;
  readonly privacyEpoch: number;
  readonly recordingGeneration: number;
}

/**
 * The sweep's one query (D-104). A universe is due when its stored `next_quiet_at` has passed, no
 * Cartographer run holds it, the account is active, nothing is being cleared and recording is on: a
 * paused universe is left exactly as it was. The partial index `geography_state_quiet_due` serves the
 * lookup. It holds no personal root, so it only reads the state row, skips rows another transaction
 * holds, and leaves every decision to the settle's own authority recheck.
 */
export function quietSweepStore(deps: {
  readonly db: Kysely<Database>;
  readonly enqueueInTransaction: EnqueueInTransaction;
}): QuietSweepStore {
  return {
    handOverDue: ({ now, limit, leaseUntil }) =>
      withTransaction(deps.db, 'geography.sweep-quiet', async (trx) => {
        await sql`select set_config('statement_timeout','5000ms',true),set_config('lock_timeout','250ms',true)`.execute(
          trx,
        );
        const due = await sql<DueUniverse>`
          select s.universe_id as "universeId", s.privacy_epoch as "privacyEpoch", u.recording_generation as "recordingGeneration"
          from geography.state s
          join identity.universes u on u.id = s.universe_id and u.privacy_epoch = s.privacy_epoch
          join identity.accounts a on a.id = u.account_id
          where s.next_quiet_at <= ${now.toISOString()}::timestamptz
            and s.active_run_id is null
            and u.status = 'active' and a.status = 'active' and u.clear_operation_id is null and u.recording_on
          order by s.next_quiet_at
          limit ${limit}
          for update of s skip locked`.execute(trx);
        for (const universe of due.rows) {
          await deps.enqueueInTransaction(trx, settleQuietQueue, { v: 1, ...universe });
          // The settle rewrites this. Until then the universe is not found again, and if the job is
          // lost the sweep finds it once the lease ends.
          await sql`update geography.state set next_quiet_at = ${leaseUntil.toISOString()}::timestamptz
            where universe_id = ${universe.universeId}::uuid and privacy_epoch = ${universe.privacyEpoch}`.execute(trx);
        }
        return due.rows.length;
      }),
  };
}
