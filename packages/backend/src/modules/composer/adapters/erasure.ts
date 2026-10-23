import { clearCoreTransactionOf } from '../../../infrastructure/postgres/privacy-scope.js';
import type { ModuleErasure } from '../../../infrastructure/erasure/registry.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
export const composerErasure: ModuleErasure = {
  module: 'composer',
  tables: [{ schema: 'composer', table: 'decisions', ownerColumn: 'universe_id' }],
  nonRowStores: [],
  async erase(scope) {
    const result = await transactionOf(scope)
      .deleteFrom('composer.decisions')
      .where('universe_id', '=', scope.authority.universeId)
      .executeTakeFirst();
    return { module: 'composer', status: 'completed', removed: Number(result.numDeletedRows) };
  },
};

composerErasure.clearExploration = {
  dispositions: Object.fromEntries([
    ...composerErasure.tables.map((t) => [`${t.schema}.${t.table}`, 'erase']),
    ...composerErasure.nonRowStores.map((s) => [`store:${s.name}`, 'erase']),
  ]) as Record<string, 'erase' | 'preserve'>,
  async erase(scope) {
    const result = await clearCoreTransactionOf(scope)
      .deleteFrom('composer.decisions')
      .where('universe_id', '=', scope.binding.universeId)
      .executeTakeFirst();
    return { module: 'composer', status: 'completed', removed: Number(result.numDeletedRows) };
  },
};
