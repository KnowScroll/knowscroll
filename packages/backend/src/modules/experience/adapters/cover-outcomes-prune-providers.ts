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
 * The universes with an expired cover outcome, in a random order each pass: one range scan of `cover_outcomes_expiry`
 * (0123), grouped by owner. Owners, not rows, are what a pass is bounded by, and the order is random, so a universe the
 * personal root keeps refusing (a suspended account) can never hold the head of the scan and starve everyone else; it is
 * just one owner among those drawn. Expired rows are pruned every thirty minutes, so the set scanned stays small. It holds
 * no personal root and writes nothing.
 */
export function expiredCoverOutcomeOwners(db: Kysely<Database>) {
  return async ({ limit }: { readonly limit: number }): Promise<readonly ExpiredCoverOutcomesOwner[]> => {
    const rows = await sql<{ universe_id: string; privacy_epoch: number }>`
      select c.universe_id, c.privacy_epoch from experience.cover_outcomes c
      where c.expires_at <= now()
      group by c.universe_id, c.privacy_epoch
      order by random() limit ${limit}`.execute(db);
    return rows.rows
      .map((row) => ({ universeId: row.universe_id, privacyEpoch: row.privacy_epoch }))
      .slice(0, PRUNE_COVER_OUTCOMES_BOUNDS.universes);
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
