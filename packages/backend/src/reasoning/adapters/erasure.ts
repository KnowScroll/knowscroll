import type { ModuleErasure } from '../../infrastructure/erasure/registry.js';
import { transactionOf } from '../../infrastructure/postgres/personal-scope.js';

/** The reasoning ledger's personal rows (runs and attempts of one universe). */
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
      .executeTakeFirst();
    const runs = await trx
      .deleteFrom('reasoning.business_runs')
      .where('universe_id', '=', universeId)
      .executeTakeFirst();
    return { module: 'reasoning', status: 'completed', removed: Number(attempts.numDeletedRows + runs.numDeletedRows) };
  },
};
