import { clearCoreTransactionOf } from '../../../infrastructure/postgres/privacy-scope.js';
import { sql } from 'kysely';
import { declareErasure } from '../../../infrastructure/erasure/declaration.js';
import { exportNothing } from '../../../infrastructure/erasure/registry.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { deleteJobPayloads, deleteClearJobPayloads } from '../../../infrastructure/jobs/erasure.js';
import { plannerQueue } from '../events.js';
const tables = ['revisions', 'state', 'runs'] as const;
export const plannerErasure = declareErasure({
  module: 'planner',
  tables: tables.map((table) => ({ schema: 'planner', table, ownerColumn: 'universe_id' })),
  accountColumns: [{ schema: 'planner', table: 'runs', column: 'recording_account_id' }],
  nonRowStores: [
    {
      name: `pgboss/${plannerQueue.name}`,
      description: 'All queued, active, retained and dead-lettered Planner job IDs.',
    },
  ],
  async erase(scope) {
    let removed = 0;
    for (const table of tables) {
      const r =
        await sql`delete from ${sql.table(`planner.${table}`)} where universe_id=${scope.authority.universeId}::uuid`.execute(
          transactionOf(scope),
        );
      removed += Number(r.numAffectedRows ?? 0);
    }
    removed += await deleteJobPayloads(scope, [plannerQueue.name]);
    return { module: 'planner', status: 'completed', removed };
  },
  clear: {
    defaultDisposition: 'erase',
    async erase(scope) {
      let removed = 0;
      for (const table of tables) {
        const r =
          await sql`delete from ${sql.table(`planner.${table}`)} where universe_id=${scope.binding.universeId}::uuid`.execute(
            clearCoreTransactionOf(scope),
          );
        removed += Number(r.numAffectedRows ?? 0);
      }
      removed += await deleteClearJobPayloads(scope, [plannerQueue.name]);
      return { module: 'planner', status: 'completed', removed };
    },
  },
  export: (declaration) => exportNothing(declaration, 'Internal plans and the runs that proposed them.'),
});
