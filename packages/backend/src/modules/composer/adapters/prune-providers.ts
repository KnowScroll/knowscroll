import type { Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import type { WithPersonalScope } from '../../identity/public.js';
import {
  makeBackfillPruneDecisions,
  makePruneDecisions,
  type BackfillPruneDecisions,
  type PruneDecisions,
} from '../application/prune-decisions.js';
import { PRUNE_COMPOSER_DECISIONS } from '../public.js';
import { makeComposerStore } from './postgres-store.js';
import { expiredDecisionOwners } from './prune-store.js';

/**
 * The worker's scheduled decision prune (`composer.prune-decisions`). It reads no decision and exposes none: it finds the
 * universes with something to delete and deletes under each one's own personal scope.
 */
export function composerPruneProviders(t: { readonly database: symbol; readonly withPersonalScope: symbol }) {
  return [
    {
      provide: PRUNE_COMPOSER_DECISIONS,
      inject: [t.database, t.withPersonalScope],
      useFactory: (db: Kysely<Database>, withPersonalScope: WithPersonalScope): PruneDecisions =>
        makePruneDecisions({
          withPersonalScope,
          prune: makeComposerStore({ isOperator: () => false }).pruneComposerDecisions,
          findOwners: expiredDecisionOwners(db),
        }),
    },
  ];
}

/**
 * The operator's one-off backfill (`composer prune-backfill`, no lookback), over the caller's own database and personal scope.
 * Composition only: nothing in a running process calls it.
 */
export function composerPruneBackfill(
  db: Kysely<Database>,
  withPersonalScope: WithPersonalScope,
): BackfillPruneDecisions {
  return makeBackfillPruneDecisions({
    withPersonalScope,
    prune: makeComposerStore({ isOperator: () => false }).pruneComposerDecisions,
    findOwners: expiredDecisionOwners(db),
  });
}
