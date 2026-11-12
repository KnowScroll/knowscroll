import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { Catalogue } from '../../content/public.js';
import type { WithPersonalScope } from '../../identity/public.js';
import {
  makeRebuildInterestRollups,
  type InterestRollupOwner,
  type RebuildInterestRollupsPorts,
} from '../application/rebuild-interest-rollups.js';
import { rebuildInterestRollups } from './interest-store.js';

/** The persons with topic rows, in universe id order: one index probe per person (the primary key of `topic_context`). */
function interestRollupOwners(db: Kysely<Database>): RebuildInterestRollupsPorts['owners'] {
  return async ({ after, limit }) => {
    const rows = await sql<{
      universe_id: string;
      privacy_epoch: number;
    }>`select distinct on (universe_id) universe_id,privacy_epoch
      from evidence.topic_context ${after === undefined ? sql`` : sql`where universe_id>${after}::uuid`}
      order by universe_id limit ${limit}`.execute(db);
    return rows.rows.map((row): InterestRollupOwner => ({
      universeId: row.universe_id,
      privacyEpoch: row.privacy_epoch,
    }));
  };
}

/**
 * The operator's pass that rebuilds every person's interest roll-ups (`evidence rebuild-interest-rollups`), over the caller's own
 * database and personal scope, with the topic catalogue that places each topic in a system. Composition only: nothing in a running
 * process calls it.
 */
export function evidenceRebuildInterestRollups(
  db: Kysely<Database>,
  withPersonalScope: WithPersonalScope,
  catalogue: Pick<Catalogue, 'current'>,
) {
  return makeRebuildInterestRollups({
    withPersonalScope,
    owners: interestRollupOwners(db),
    // A topic's system never changes once it is in the catalogue, so the release each person is read against does not matter.
    rebuild: async (scope) => ({
      topics: (
        await rebuildInterestRollups(transactionOf(scope), scope.authority, (await catalogue.current()).systemOf)
      ).topics,
    }),
  });
}
