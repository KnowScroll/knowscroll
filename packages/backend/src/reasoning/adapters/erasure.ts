import { sql } from 'kysely';
import type { ModuleErasure } from '../../infrastructure/erasure/registry.js';
import { transactionOf } from '../../infrastructure/postgres/personal-scope.js';

/**
 * The reasoning ledger's personal rows. Settled attempts and their runs are erased; attempts whose
 * outcome is still open (`dispatched`, `unknown`) are kept, with their runs, as unresolved
 * liability (blueprint §15: minimal accounting identity survives until reconciled or written off)
 * and the report says `pending`, so the eraser is retried after reconciliation.
 */
export const reasoningErasure: ModuleErasure = {
  module: 'reasoning',
  tables: [
    { schema: 'reasoning', table: 'external_attempts', ownerColumn: 'universe_id' },
    { schema: 'reasoning', table: 'business_runs', ownerColumn: 'universe_id' },
  ],
  nonRowStores: [],
  async erase(scope) {
    const trx = transactionOf(scope);
    const universeId = scope.authority.universeId;
    const attempts = await trx
      .deleteFrom('reasoning.external_attempts')
      .where('universe_id', '=', universeId)
      .where('state', 'not in', ['dispatched', 'unknown'])
      .executeTakeFirst();
    const runs = await trx
      .deleteFrom('reasoning.business_runs as run')
      .where('run.universe_id', '=', universeId)

      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('reasoning.external_attempts as attempt')
              .select(sql<number>`1`.as('one'))
              .whereRef('attempt.universe_id', '=', 'run.universe_id')
              .whereRef('attempt.run_id', '=', 'run.id'),
          ),
        ),
      )
      .executeTakeFirst();
    const open = await trx
      .selectFrom('reasoning.external_attempts')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('universe_id', '=', universeId)
      .executeTakeFirstOrThrow();
    return {
      module: 'reasoning',
      status: Number(open.n) > 0 ? 'pending' : 'completed',
      removed: Number(attempts.numDeletedRows + runs.numDeletedRows),
    };
  },
};
