import { clearCoreTransactionOf } from '../../../infrastructure/postgres/privacy-scope.js';
import type { ModuleErasure } from '../../../infrastructure/erasure/registry.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { deleteJobPayloads, deleteClearJobPayloads } from '../../../infrastructure/jobs/erasure.js';
import { resolveSupplyQueue } from '../events.js';
/** Shared work contains public briefs only; erase private asks/waiters and every retained job ID. */
export const supplyErasure: ModuleErasure = {
  module: 'supply',
  tables: [{ schema: 'supply', table: 'requests', ownerColumn: 'universe_id' }],
  nonRowStores: [
    {
      name: `pgboss/${resolveSupplyQueue.name}`,
      description: 'Queued, active, retained and dead-lettered private request IDs.',
    },
  ],
  async erase(scope) {
    const removed = await transactionOf(scope)
      .deleteFrom('supply.requests')
      .where('universe_id', '=', scope.authority.universeId)
      .executeTakeFirst();
    return {
      module: 'supply',
      status: 'completed',
      removed: Number(removed.numDeletedRows) + (await deleteJobPayloads(scope, [resolveSupplyQueue.name])),
    };
  },
};

supplyErasure.clearExploration = {
  dispositions: Object.fromEntries([
    ...supplyErasure.tables.map((t) => [`${t.schema}.${t.table}`, 'erase']),
    ...supplyErasure.nonRowStores.map((s) => [`store:${s.name}`, 'erase']),
  ]) as Record<string, 'erase' | 'preserve'>,
  async erase(scope) {
    const removed = await clearCoreTransactionOf(scope)
      .deleteFrom('supply.requests')
      .where('universe_id', '=', scope.binding.universeId)
      .executeTakeFirst();
    return {
      module: 'supply',
      status: 'completed',
      removed: Number(removed.numDeletedRows) + (await deleteClearJobPayloads(scope, [resolveSupplyQueue.name])),
    };
  },
};
