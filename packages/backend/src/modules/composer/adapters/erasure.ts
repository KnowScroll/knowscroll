import { sql } from 'kysely';
import { clearCoreTransactionOf } from '../../../infrastructure/postgres/privacy-scope.js';
import { exportNothing, type ModuleErasure } from '../../../infrastructure/erasure/registry.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { deleteClearJobPayloads, deleteJobPayloads } from '../../../infrastructure/jobs/erasure.js';
import { prepareBufferQueue } from '../events.js';

/** Buffers reference decisions, so they are deleted first. */
export const composerErasure: ModuleErasure = {
  module: 'composer',
  tables: [
    { schema: 'composer', table: 'buffers', ownerColumn: 'universe_id' },
    { schema: 'composer', table: 'decisions', ownerColumn: 'universe_id' },
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
    const jobs = await deleteJobPayloads(scope, [prepareBufferQueue.name]);
    return {
      module: 'composer',
      status: 'completed',
      removed: Number(buffers.numAffectedRows ?? 0) + Number(decisions.numAffectedRows ?? 0) + jobs,
    };
  },
};

composerErasure.clearExploration = {
  dispositions: Object.fromEntries([
    ...composerErasure.tables.map((t) => [`${t.schema}.${t.table}`, 'erase']),
    ...composerErasure.nonRowStores.map((s) => [`store:${s.name}`, 'erase']),
  ]) as Record<string, 'erase' | 'preserve'>,
  async erase(scope) {
    const db = clearCoreTransactionOf(scope);
    const universeId = scope.binding.universeId;
    const buffers = await sql`delete from composer.buffers where universe_id=${universeId}::uuid`.execute(db);
    const decisions = await sql`delete from composer.decisions where universe_id=${universeId}::uuid`.execute(db);
    const jobs = await deleteClearJobPayloads(scope, [prepareBufferQueue.name]);
    return {
      module: 'composer',
      status: 'completed',
      removed: Number(buffers.numAffectedRows ?? 0) + Number(decisions.numAffectedRows ?? 0) + jobs,
    };
  },
};

composerErasure.export = exportNothing(composerErasure, 'Internal ranking decisions and prepared next moves.');
