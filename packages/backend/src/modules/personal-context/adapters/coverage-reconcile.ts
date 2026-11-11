import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';

/** What a reconciliation found or marked: the universes with support and the (universe, topic) pairs under them. */
export interface CoverageReconciliation {
  readonly universes: number;
  readonly topics: number;
}

/**
 * The one-time reconciliation for readers who read before dirty tracking existed (#674, D-416): marks every topic that has a
 * support key dirty, for one universe or for all, at the universe's current revision. The next Cartographer runs of those
 * readers take the topics newest-first in batches, one paced run per batch, so history is read once and never again unless it
 * changes. It marks rows only (an existing row keeps its later revision); it reads no support, calls no model and starts no
 * run, and running it twice marks nothing new. With `dryRun` it counts and writes nothing. Operator command
 * `geography reconcile-coverage`.
 */
export async function reconcileCoverageDirty(
  db: Kysely<Database>,
  options: { readonly universeId?: string; readonly dryRun: boolean },
): Promise<CoverageReconciliation> {
  const universe = options.universeId === undefined ? sql`` : sql`and s.universe_id = ${options.universeId}::uuid`;
  const pairs = sql`select distinct s.universe_id, s.privacy_epoch, s.topic_id, greatest(u.revision, 1) as dirty_revision
    from personal_context.coverage_supports s
    join identity.universes u on u.id = s.universe_id and u.privacy_epoch = s.privacy_epoch
    where true ${universe}`;
  if (options.dryRun) {
    const row = (
      await sql<{
        universes: number;
        topics: number;
      }>`select count(distinct pair.universe_id)::int as universes, count(*)::int as topics
        from (${pairs}) pair
        where not exists (select 1 from personal_context.coverage_dirty_topics d
          where d.universe_id = pair.universe_id and d.privacy_epoch = pair.privacy_epoch and d.topic_id = pair.topic_id)`.execute(
        db,
      )
    ).rows[0]!;
    return row;
  }
  const row = (
    await sql<{ universes: number; topics: number }>`with marked as (
        insert into personal_context.coverage_dirty_topics (universe_id, privacy_epoch, topic_id, dirty_revision)
        select universe_id, privacy_epoch, topic_id, dirty_revision from (${pairs}) pair
        on conflict (universe_id, privacy_epoch, topic_id) do nothing
        returning universe_id)
      select count(distinct universe_id)::int as universes, count(*)::int as topics from marked`.execute(db)
  ).rows[0]!;
  return row;
}
