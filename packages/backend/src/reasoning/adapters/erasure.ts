import { sql } from 'kysely';
import type { ModuleErasure } from '../../infrastructure/erasure/registry.js';
import { transactionOf } from '../../infrastructure/postgres/personal-scope.js';

/**
 * The reasoning engine's personal rows (blueprint §5 erasure registry, §15 accounting identity).
 *
 * - Protected request bytes: all of the universe's are deleted, including those of attempts whose
 *   outcome is still open — the bytes are private context, and the attempt's hash is enough to
 *   account for it.
 * - Attempts: settled ones are deleted (with their stored outputs and validator issues); attempts
 *   still `dispatched` or `unknown` are kept, with their runs, as unresolved liability, and the
 *   report says `pending` so the eraser is retried after reconciliation or write-off.
 * - Runs without remaining attempts are deleted.
 *
 * Outside our database: a request sent to MiniMax leaves a copy there (see `nonRowStores`).
 *
 * Usage receipts (`reasoning.usage_receipts`) are not personal: keyed by attempt ID only, with no
 * universe, purpose, context or output, they survive so global and per-role budgets stay honest
 * and late usage can still settle (blueprint §15 "minimal accounting identity").
 */
export const reasoningErasure: ModuleErasure = {
  module: 'reasoning',
  tables: [
    { schema: 'reasoning', table: 'protected_requests', ownerColumn: 'universe_id' },
    { schema: 'reasoning', table: 'external_attempts', ownerColumn: 'universe_id' },
    { schema: 'reasoning', table: 'business_runs', ownerColumn: 'universe_id' },
  ],
  nonRowStores: [
    {
      name: 'minimax/request-copies',
      description:
        "Copies of requests sent to MiniMax (bounded context items) and its answers, under MiniMax's own retention and terms (D-021); we keep no handle to find or delete them, so no eraser of ours reaches them and the privacy copy must say so",
    },
  ],
  async erase(scope) {
    const trx = transactionOf(scope);
    const universeId = scope.authority.universeId;
    const requests = await trx
      .deleteFrom('reasoning.protected_requests')
      .where('universe_id', '=', universeId)
      .executeTakeFirst();
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
      removed: Number(requests.numDeletedRows + attempts.numDeletedRows + runs.numDeletedRows),
    };
  },
};
