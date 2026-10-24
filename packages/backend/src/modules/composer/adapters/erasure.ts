import { sql } from 'kysely';
import { clearCoreTransactionOf } from '../../../infrastructure/postgres/privacy-scope.js';
import { declareErasure } from '../../../infrastructure/erasure/declaration.js';
import { exportNothing } from '../../../infrastructure/erasure/registry.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { deleteClearJobPayloads, deleteJobPayloads } from '../../../infrastructure/jobs/erasure.js';
import { prepareBufferQueue } from '../events.js';

/** Buffers reference decisions, so they are deleted first. The Jev pool references nothing. */
export const composerErasure = declareErasure({
  module: 'composer',
  tables: [
    { schema: 'composer', table: 'buffers', ownerColumn: 'universe_id' },
    { schema: 'composer', table: 'decisions', ownerColumn: 'universe_id' },
    { schema: 'composer', table: 'jev_assessments', ownerColumn: 'universe_id' },
  ],
  nonRowStores: [
    {
      name: `pgboss/${prepareBufferQueue.name}`,
      description: 'All queued, active and retained buffer-preparation job IDs.',
    },
  ],
  async erase(scope) {
    const db = transactionOf(scope);
    const universeId = scope.authority.universeId;
    const buffers = await sql`delete from composer.buffers where universe_id=${universeId}::uuid`.execute(db);
    const decisions = await sql`delete from composer.decisions where universe_id=${universeId}::uuid`.execute(db);
    const assessments = await sql`delete from composer.jev_assessments where universe_id=${universeId}::uuid`.execute(
      db,
    );
    const jobs = await deleteJobPayloads(scope, [prepareBufferQueue.name]);
    return {
      module: 'composer',
      status: 'completed',
      removed:
        Number(buffers.numAffectedRows ?? 0) +
        Number(decisions.numAffectedRows ?? 0) +
        Number(assessments.numAffectedRows ?? 0) +
        jobs,
    };
  },
  clear: {
    defaultDisposition: 'erase',
    async erase(scope) {
      const db = clearCoreTransactionOf(scope);
      const universeId = scope.binding.universeId;
      const buffers = await sql`delete from composer.buffers where universe_id=${universeId}::uuid`.execute(db);
      const decisions = await sql`delete from composer.decisions where universe_id=${universeId}::uuid`.execute(db);
      const assessments = await sql`delete from composer.jev_assessments where universe_id=${universeId}::uuid`.execute(
        db,
      );
      const jobs = await deleteClearJobPayloads(scope, [prepareBufferQueue.name]);
      return {
        module: 'composer',
        status: 'completed',
        removed:
          Number(buffers.numAffectedRows ?? 0) +
          Number(decisions.numAffectedRows ?? 0) +
          Number(assessments.numAffectedRows ?? 0) +
          jobs,
      };
    },
  },
  export: (declaration) =>
    exportNothing(declaration, 'Internal ranking decisions, prepared next moves and stored assessments.'),
});
