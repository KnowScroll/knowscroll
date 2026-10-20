import type { ModuleErasure } from '../../../infrastructure/erasure/registry.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { deleteJobPayloads } from '../../../infrastructure/jobs/erasure.js';
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
