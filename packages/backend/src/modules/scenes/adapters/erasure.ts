import { sql } from 'kysely';
import type { ModuleErasure } from '../../../infrastructure/erasure/registry.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { deleteJobPayloads } from '../../../infrastructure/jobs/erasure.js';
import { projectSceneQueue } from '../events.js';
const tables = ['manifests', 'chunks', 'objects', 'state'] as const;
export const scenesErasure: ModuleErasure = {
  module: 'scenes',
  tables: tables.map((table) => ({ schema: 'scenes', table, ownerColumn: 'universe_id' })),
  nonRowStores: [
    {
      name: `pgboss/${projectSceneQueue.name}`,
      description: 'All queued, active, settled and dead-lettered private Scene scope IDs.',
    },
  ],
  async erase(scope) {
    let removed = 0;
    for (const table of tables) {
      const r =
        await sql`delete from ${sql.table(`scenes.${table}`)} where universe_id=${scope.authority.universeId}::uuid`.execute(
          transactionOf(scope),
        );
      removed += Number(r.numAffectedRows ?? 0);
    }
    removed += await deleteJobPayloads(scope, [projectSceneQueue.name]);
    return { module: 'scenes', status: 'completed', removed };
  },
};
