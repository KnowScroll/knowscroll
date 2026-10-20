import type { ModuleErasure } from '../../../infrastructure/erasure/registry.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';

/** Experience's personal tables and their eraser (blueprint §5). */
export const experienceErasure: ModuleErasure = {
  module: 'experience',
  tables: [
    { schema: 'experience', table: 'saved_items', ownerColumn: 'universe_id' },
    { schema: 'experience', table: 'actions', ownerColumn: 'universe_id' },
    { schema: 'experience', table: 'exposures', ownerColumn: 'universe_id' },
  ],
  nonRowStores: [],
  async erase(scope) {
    const trx = transactionOf(scope);
    const universeId = scope.authority.universeId;
    const saved = await trx
      .deleteFrom('experience.saved_items')
      .where('universe_id', '=', universeId)
      .executeTakeFirst();
    const actions = await trx.deleteFrom('experience.actions').where('universe_id', '=', universeId).executeTakeFirst();
    const exposures = await trx
      .deleteFrom('experience.exposures')
      .where('universe_id', '=', universeId)
      .executeTakeFirst();
    return {
      module: 'experience',
      status: 'completed',
      removed: Number(saved.numDeletedRows + actions.numDeletedRows + exposures.numDeletedRows),
    };
  },
};
