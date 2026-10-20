import { sql } from 'kysely';
import type { ModuleErasure } from '../../../infrastructure/erasure/registry.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { deleteJobPayloads } from '../../../infrastructure/jobs/erasure.js';
import { cartographyQueue, publishDeltaQueue } from '../events.js';
const tables = ['deltas', 'relations', 'objects', 'state', 'runs'] as const;
export const geographyErasure: ModuleErasure = {
  module: 'geography',
  tables: tables.map((table) => ({ schema: 'geography', table, ownerColumn: 'universe_id' })),
  nonRowStores: [cartographyQueue, publishDeltaQueue].map((q) => ({
    name: `pgboss/${q.name}`,
    description: 'All queued, active, settled and dead-lettered private geography IDs.',
  })),
  async erase(scope) {
    let removed = 0;
    for (const table of tables) {
      const r =
        await sql`delete from ${sql.table(`geography.${table}`)} where universe_id=${scope.authority.universeId}::uuid`.execute(
          transactionOf(scope),
        );
      removed += Number(r.numAffectedRows ?? 0);
    }
    removed += await deleteJobPayloads(scope, [cartographyQueue.name, publishDeltaQueue.name]);
    return { module: 'geography', status: 'completed', removed };
  },
};
