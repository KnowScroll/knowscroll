import { sql, type Kysely } from 'kysely';
import type { PgBoss } from 'pg-boss';
import { stableUuid } from '../../../infrastructure/ids/index.js';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { WAIT_LIMIT_MS } from '../application/commission.js';
import { LOST_WAITER_GRACE_MS } from '../domain/planned-demand.js';
import { resolveSupplyQueue } from '../events.js';

export interface ExpiredPlannedDemand {
  /** Planned demand still `deferred` long past the wait limit, oldest first, at most `limit`. */
  readonly stale: number;
  readonly queued: number;
  /** Stale demand whose job for today already exists. */
  readonly alreadyQueued: number;
  /** More stale demand exists than this run took; run it again. */
  readonly more: boolean;
}

/** The most stale demand one run takes unless told otherwise. */
const DEFAULT_EXPIRE_LIMIT = 100;

/**
 * The bounded recovery for planned demand that lost its resolver (a poll chain dead-lettered, a worker down, demand
 * from before Create): an operator command that sends one resolver job for each planned demand still `deferred` past the
 * wait limit and its grace. The resolver does the closing under the person's own scope, as it does for any waiter that
 * waited too long: it binds content that arrived meanwhile, or ends the demand as `could_not_prepare`, and commissions
 * nothing for a demand this old. The job's identity names the request and the UTC day, so a second run on the same day
 * sends nothing new and a later day can try again. Reads the shared table across universes (IDs only) and sends no
 * personal data; the job names the universe, the epoch and the request.
 */
export async function expireStalePlannedDemand(
  db: Kysely<Database>,
  boss: PgBoss,
  options: { readonly dryRun: boolean; readonly limit?: number; readonly now?: Date },
): Promise<ExpiredPlannedDemand> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? DEFAULT_EXPIRE_LIMIT;
  const cutoff = new Date(now.getTime() - WAIT_LIMIT_MS - LOST_WAITER_GRACE_MS);
  const rows = await db
    .selectFrom('supply.requests')
    .select(['universe_id', 'privacy_epoch', 'id'])
    .where('origin', '=', 'planner')
    .where('state', '=', 'deferred')
    .where(sql<boolean>`coalesce(wait_started_at, created_at) < ${cutoff}`)
    .orderBy('created_at')
    .orderBy('id')
    .limit(limit + 1)
    .execute();
  const taken = rows.slice(0, limit);
  const day = now.toISOString().slice(0, 10);
  let queued = 0;
  let alreadyQueued = 0;
  if (!options.dryRun)
    for (const row of taken) {
      const sent = await boss.send(
        resolveSupplyQueue.name,
        resolveSupplyQueue.payload.parse({
          v: 1,
          universeId: row.universe_id,
          privacyEpoch: row.privacy_epoch,
          requestId: row.id,
        }),
        { id: stableUuid(`supply-expire-planned:${row.id}:${day}`) },
      );
      if (sent === null) alreadyQueued += 1;
      else queued += 1;
    }
  return { stale: taken.length, queued, alreadyQueued, more: rows.length > limit };
}
