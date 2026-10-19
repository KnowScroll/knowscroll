import type { ModuleErasure } from '../erasure/registry.js';
import { transactionOf } from '../postgres/personal-scope.js';

/** Personal command receipts of one universe. Shared receipts follow the shared scope's lifecycle. */
export const receiptsErasure: ModuleErasure = {
  module: 'receipts',
  tables: [{ schema: 'receipts', table: 'personal_commands', ownerColumn: 'universe_id' }],
  nonRowStores: [],
  async erase(scope) {
    const result = await transactionOf(scope)
      .deleteFrom('receipts.personal_commands')
      .where('universe_id', '=', scope.authority.universeId)
      .executeTakeFirst();
    return { module: 'receipts', status: 'completed', removed: Number(result.numDeletedRows) };
  },
};
