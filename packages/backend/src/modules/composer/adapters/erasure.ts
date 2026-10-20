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
