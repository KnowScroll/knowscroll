import type { Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import type { WithPersonalScope } from '../../identity/public.js';
import { makePruneDecisions, type PruneDecisions } from '../application/prune-decisions.js';
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
