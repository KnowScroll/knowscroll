import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import type { WithPersonalScope } from '../../identity/public.js';
import {
  makePruneCoverOutcomes,
  PRUNE_COVER_OUTCOMES_BOUNDS,
  type ExpiredCoverOutcomesOwner,
  type PruneCoverOutcomes,
} from '../application/prune-cover-outcomes.js';
import { PRUNE_COVER_OUTCOMES } from '../public.js';
import { pruneCoverOutcomes } from './cover-outcomes-store.js';

/**
 * The universes with an expired cover outcome: one range scan of `cover_outcomes_expiry` (0123), oldest first. It holds no
 * personal root and writes nothing. A universe may appear on many rows; at most `limit * 8` rows are read.
 */
export function expiredCoverOutcomeOwners(db: Kysely<Database>) {
  return async ({ limit }: { readonly limit: number }): Promise<readonly ExpiredCoverOutcomesOwner[]> => {
    const rows = await sql<{ universe_id: string; privacy_epoch: number }>`
      select c.universe_id, c.privacy_epoch from experience.cover_outcomes c
      where c.expires_at <= now() order by c.expires_at limit ${limit * 8}`.execute(db);
    const owners = new Map<string, ExpiredCoverOutcomesOwner>();
    for (const row of rows.rows)
      owners.set(`${row.universe_id}:${String(row.privacy_epoch)}`, {
        universeId: row.universe_id,
        privacyEpoch: row.privacy_epoch,
      });
    return [...owners.values()].slice(0, PRUNE_COVER_OUTCOMES_BOUNDS.universes);
  };
}

/** The worker's scheduled cover-outcome prune. It reads no row and exposes none. */
export function coverOutcomesPruneProviders(t: { readonly database: symbol; readonly withPersonalScope: symbol }) {
  return [
    {
      provide: PRUNE_COVER_OUTCOMES,
      inject: [t.database, t.withPersonalScope],
      useFactory: (db: Kysely<Database>, withPersonalScope: WithPersonalScope): PruneCoverOutcomes =>
        makePruneCoverOutcomes({
          withPersonalScope,
          prune: pruneCoverOutcomes,
          findOwners: expiredCoverOutcomeOwners(db),
        }),
    },
  ];
}
