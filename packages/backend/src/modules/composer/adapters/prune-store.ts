import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import type { ExpiredDecisionsOwner, PruneDecisionsPorts } from '../application/prune-decisions.js';

/**
 * The universes with expired decisions that nothing holds, for the scheduled prune and its backfill. One range scan of
 * `composer_decisions_expired_idx` (migration 0108), oldest first, probing `offers_decision_idx` and the one buffer a
 * universe may have per row (an expired buffer does not hold: the prune deletes it first), so a decision an offer holds is
 * skipped without being read. At most `limit * 8` rows are looked at; `next` is the key of the last one when there may be
 * more, so a caller can continue past it. With `lookbackDays` only recently expired decisions are scanned (the scheduled
 * pass); without it all of them are (the backfill). It holds no personal root and writes nothing.
 */
export function expiredDecisionOwners(db: Kysely<Database>): PruneDecisionsPorts['findOwners'] {
  return async ({ limit, lookbackDays, after }) => {
    const rows = await sql<{ universe_id: string; privacy_epoch: number; expires_text: string; id: string }>`
      select d.universe_id,d.privacy_epoch,d.expires_at::text as expires_text,d.id from composer.decisions d
      where d.expires_at<=now()
        ${lookbackDays === undefined ? sql`` : sql`and d.expires_at>now()-make_interval(days => ${lookbackDays}::int)`}
        ${after === undefined ? sql`` : sql`and (d.expires_at,d.id)>(${after.expiresAt}::timestamptz,${after.id}::uuid)`}
        and not exists(select 1 from experience.offers o where o.universe_id=d.universe_id and o.privacy_epoch=d.privacy_epoch and o.decision_id=d.id)
        and not exists(select 1 from composer.buffers b where b.universe_id=d.universe_id and b.decision_id=d.id and b.expires_at>now())
      order by d.expires_at,d.id limit ${limit * 8}`.execute(db);
    const owners = new Map<string, ExpiredDecisionsOwner>();
    for (const row of rows.rows)
      owners.set(`${row.universe_id}:${String(row.privacy_epoch)}`, {
        universeId: row.universe_id,
        privacyEpoch: row.privacy_epoch,
      });
    const last = rows.rows.at(-1);
    return {
      owners: [...owners.values()],
      ...(rows.rows.length === limit * 8 && last !== undefined
        ? { next: { expiresAt: last.expires_text, id: last.id } }
        : {}),
    };
  };
}
