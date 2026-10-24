import { clearCoreTransactionOf } from '../../../infrastructure/postgres/privacy-scope.js';
import { sql } from 'kysely';
import { declareErasure } from '../../../infrastructure/erasure/declaration.js';
import { exportNothing } from '../../../infrastructure/erasure/registry.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { deleteJobPayloads, deleteClearJobPayloads } from '../../../infrastructure/jobs/erasure.js';
import { projectSceneQueue, expireFormationQueue, recoverFormationQueue } from '../events.js';
const tables = ['formation_presentations', 'manifests', 'chunks', 'objects', 'state'] as const;
export const scenesErasure = declareErasure({
  module: 'scenes',
  tables: tables.map((table) => ({ schema: 'scenes', table, ownerColumn: 'universe_id' })),
  nonRowStores: [
    {
      name: `pgboss/${recoverFormationQueue.name}`,
      description:
        'Global maintenance ordinal cursor only: version/afterKey/throughKey, no personal UUID, nonce, label or fact. Finite100-key captured-ceiling passes; max7d queued/2d settled retention. Erasing a row removes its ordinal-to-personal link; no per-account effects or recreation authority.',
    },
    {
      name: `pgboss/${expireFormationQueue.name}`,
      description:
        'Exact private presentation claim IDs in all queued/active/settled/dead-letter states; erased with owner.',
    },
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
    removed += await deleteJobPayloads(scope, [projectSceneQueue.name, expireFormationQueue.name]);
    return { module: 'scenes', status: 'completed', removed };
  },
  clear: {
    defaultDisposition: 'erase',
    // The recovery cursor is global maintenance state with no personal link.
    dispositions: { [`store:pgboss/${recoverFormationQueue.name}`]: 'preserve' },
    async erase(scope) {
      let removed = 0;
      for (const table of tables) {
        const r =
          await sql`delete from ${sql.table(`scenes.${table}`)} where universe_id=${scope.binding.universeId}::uuid`.execute(
            clearCoreTransactionOf(scope),
          );
        removed += Number(r.numAffectedRows ?? 0);
      }
      removed += await deleteClearJobPayloads(scope, [projectSceneQueue.name, expireFormationQueue.name]);
      return { module: 'scenes', status: 'completed', removed };
    },
  },
  export: (declaration) =>
    exportNothing(declaration, 'A rendering cache of the universe structure listed under geography.'),
});
