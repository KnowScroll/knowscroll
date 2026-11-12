import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { withTransaction } from '../../../infrastructure/postgres/personal-scope.js';
import type { EnqueueInTransaction } from '../../../infrastructure/jobs/enqueue.js';
import { QUIET_SWEEP } from '../domain/quiet.js';
import type { QuietSweepStore } from '../application/quiet.js';
import { settleQuietQueue } from '../events.js';

interface DuePlace {
  readonly id: string;
  readonly universeId: string;
  readonly privacyEpoch: number;
  readonly recordingGeneration: number | null;
  readonly settleable: boolean;
  /** The universe could be settled but a Cartographer run holds it right now. */
  readonly runHeld: boolean;
}

/** Moves the next look of these places, found by universe and id, to `at`. */
async function moveQuietCheck(
  trx: Parameters<Parameters<typeof withTransaction>[2]>[0],
  places: readonly DuePlace[],
  at: Date,
): Promise<void> {
  if (!places.length) return;
  await sql`update geography.objects o set quiet_check_at = ${at.toISOString()}::timestamptz
    from unnest(${places.map((place) => place.universeId)}::uuid[], ${places.map((place) => place.id)}::uuid[]) as due(universe_id, id)
    where o.universe_id = due.universe_id and o.id = due.id`.execute(trx);
}

/**
 * The sweep's one query (D-104, D-105, D-416). It takes the first `limit` places whose `quiet_check_at` has passed, oldest
 * first, through the partial index `geography_object_quiet_due`, across universes, and classifies the universe of each:
 * settleable when no Cartographer run holds it, the account is active, nothing is being cleared and recording is on. The
 * settleable universe gets settle jobs naming its due places (at most `QUIET_SWEEP.placesPerSettle` each) and the places
 * a short lease; the places of a universe a run holds wait minutes (`runHeldMs`), those of any other are parked a day
 * ahead. Either way every place leaves the head of the index, so one page reads at most `limit` rows however many universes
 * are refused, and the head is always settleable. A paused universe is left exactly as it was except for these scheduling
 * times.
 *
 * It holds no personal root, so it only reads and writes the place rows it looked at, skips rows another
 * transaction holds, and leaves every decision to the settle's own authority recheck.
 */
export function quietSweepStore(deps: {
  readonly db: Kysely<Database>;
  readonly enqueueInTransaction: EnqueueInTransaction;
}): QuietSweepStore {
  return {
    handOverDue: ({ now, limit, leaseUntil, parkUntil, runHeldUntil }) =>
      withTransaction(deps.db, 'geography.sweep-quiet', async (trx) => {
        await sql`select set_config('statement_timeout','5000ms',true),set_config('lock_timeout','250ms',true)`.execute(
          trx,
        );
        const due = await sql<DuePlace>`
          with due as (
            select o.id, o.universe_id, o.privacy_epoch, o.quiet_check_at
            from geography.objects o
            where o.quiet_check_at <= ${now.toISOString()}::timestamptz
            order by o.quiet_check_at, o.id
            limit ${limit}
            for update of o skip locked)
          select due.id, due.universe_id as "universeId", due.privacy_epoch as "privacyEpoch",
            u.recording_generation as "recordingGeneration",
            coalesce(s.active_run_id is null and u.status = 'active' and a.status = 'active'
              and u.clear_operation_id is null and u.recording_on, false) as "settleable",
            coalesce(s.active_run_id is not null and u.status = 'active' and a.status = 'active'
              and u.clear_operation_id is null and u.recording_on, false) as "runHeld"
          from due
          left join identity.universes u on u.id = due.universe_id and u.privacy_epoch = due.privacy_epoch
          left join identity.accounts a on a.id = u.account_id
          left join geography.state s on s.universe_id = due.universe_id and s.privacy_epoch = due.privacy_epoch
          order by due.quiet_check_at, due.id`.execute(trx);
        const settleable = new Map<
          string,
          { universe: DuePlace & { readonly recordingGeneration: number }; ids: string[] }
        >();
        const parked: DuePlace[] = [];
        const held: DuePlace[] = [];
        for (const place of due.rows) {
          if (!place.settleable || place.recordingGeneration === null) {
            (place.runHeld ? held : parked).push(place);
            continue;
          }
          const key = `${place.universeId}|${String(place.privacyEpoch)}`;
          const group = settleable.get(key) ?? {
            universe: { ...place, recordingGeneration: place.recordingGeneration },
            ids: [],
          };
          group.ids.push(place.id);
          settleable.set(key, group);
        }
        let handedOver = 0;
        const leased: DuePlace[] = [];
        for (const { universe, ids } of settleable.values())
          for (let start = 0; start < ids.length; start += QUIET_SWEEP.placesPerSettle) {
            const chunk = ids.slice(start, start + QUIET_SWEEP.placesPerSettle);
            await deps.enqueueInTransaction(trx, settleQuietQueue, {
              v: 2,
              universeId: universe.universeId,
              privacyEpoch: universe.privacyEpoch,
              recordingGeneration: universe.recordingGeneration,
              objectIds: chunk,
            });
            leased.push(...chunk.map((id) => ({ ...universe, id })));
            handedOver += chunk.length;
          }
        // The settle rewrites a lease. A parked time stands until the sweep looks again; a run's apply rewrites it
        // sooner. If a settle job is lost, the sweep finds the place when the lease ends.
        await moveQuietCheck(trx, leased, leaseUntil);
        await moveQuietCheck(trx, held, runHeldUntil);
        await moveQuietCheck(trx, parked, parkUntil);
        return { looked: due.rows.length, handedOver };
      }),
  };
}
