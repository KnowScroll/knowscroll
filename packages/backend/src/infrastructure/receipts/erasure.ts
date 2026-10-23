import { clearCoreTransactionOf } from '../postgres/privacy-scope.js';
import type { ModuleErasure } from '../erasure/registry.js';
import { transactionOf } from '../postgres/personal-scope.js';

/** Personal command receipts of one universe. Shared receipts follow the shared scope's lifecycle. */
export const receiptsErasure: ModuleErasure = {
  module: 'receipts',
  tables: [{ schema: 'receipts', table: 'personal_commands', ownerColumn: 'universe_id' }],
  nonRowStores: [],
  // Shared receipts reference the acting account; account deletion handles them (S1.x privacy work).
  accountColumns: [{ schema: 'receipts', table: 'shared_commands', column: 'actor_account_id' }],
  async erase(scope) {
    const result = await transactionOf(scope)
      .deleteFrom('receipts.personal_commands')
      .where('universe_id', '=', scope.authority.universeId)
      .executeTakeFirst();
    return { module: 'receipts', status: 'completed', removed: Number(result.numDeletedRows) };
  },
};

receiptsErasure.clearExploration = {
  dispositions: { 'receipts.personal_commands': 'erase', 'receipts.shared_commands': 'preserve' },
  async erase(scope) {
    const result = await clearCoreTransactionOf(scope)
      .deleteFrom('receipts.personal_commands')
      .where('universe_id', '=', scope.binding.universeId)
      .where('privacy_epoch', '<=', scope.binding.fromEpoch)
      .executeTakeFirst();
    return { module: 'receipts', status: 'completed', removed: Number(result.numDeletedRows) };
  },
};
