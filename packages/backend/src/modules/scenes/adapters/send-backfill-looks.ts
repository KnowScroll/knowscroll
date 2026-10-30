import { sql, type Kysely } from 'kysely';
import type { PgBoss } from 'pg-boss';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { backfillLooksQueue } from '../events.js';

export interface BackfillLooksSent {
  /** Universes picked this run: projected systems, planets or regions without a look. */
  readonly found: number;
  /** Jobs sent now (none in a dry run). */
  readonly queued: number;
  /** More universes were left over the limit; run the command again. */
  readonly more: boolean;
}

/**
 * The operator's backfill for worlds projected before looks existed (D-102). It finds universes whose
 * projected systems, planets or regions lack a look and sends one `scenes.backfill-looks` job for each,
 * oldest id first, at most `limit` per run. The worker does the work under each universe's own lock and
 * rechecks authority; nothing is assigned here. Running it again is harmless: a universe that has all its
 * looks is no longer found, and a second job for one that is still queued assigns nothing. Reads personal
 * tables across universes for IDs only, and the jobs name only the universe and its epoch.
 */
export async function sendBackfillLooks(
  db: Kysely<Database>,
  boss: PgBoss,
  options: { readonly dryRun: boolean; readonly limit: number },
): Promise<BackfillLooksSent> {
  const rows = await sql<{ universe_id: string; privacy_epoch: number }>`
    select o.universe_id, o.privacy_epoch
    from scenes.objects o
    join identity.universes u on u.id = o.universe_id and u.privacy_epoch = o.privacy_epoch
    where o.payload -> 'descriptor' ->> 'kind' in ('system', 'planet', 'region')
      and not exists (
        select 1 from scenes.looks l
        where l.universe_id = o.universe_id and l.privacy_epoch = o.privacy_epoch and l.object_id = o.object_id
      )
    group by o.universe_id, o.privacy_epoch
    order by o.universe_id
    limit ${options.limit + 1}`.execute(db);
  const found = rows.rows.slice(0, options.limit);
  if (!options.dryRun)
    for (const row of found)
      await boss.send(
        backfillLooksQueue.name,
        backfillLooksQueue.payload.parse({ v: 1, universeId: row.universe_id, privacyEpoch: row.privacy_epoch }),
      );
  return { found: found.length, queued: options.dryRun ? 0 : found.length, more: rows.rows.length > options.limit };
}
