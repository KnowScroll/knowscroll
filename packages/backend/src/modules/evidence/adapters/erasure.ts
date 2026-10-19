import type { ModuleErasure } from '../../../infrastructure/erasure/registry.js';
import { deleteJobPayloads } from '../../../infrastructure/jobs/erasure.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { applyActionEvidenceQueue } from '../events.js';

/** Evidence's personal tables, its queue payloads, and their eraser (blueprint §5). */
export const evidenceErasure: ModuleErasure = {
  module: 'evidence',
  tables: [{ schema: 'evidence', table: 'action_events', ownerColumn: 'universe_id' }],
  nonRowStores: [
    {
      name: `pgboss/${applyActionEvidenceQueue.name}`,
      description: 'Queued, active, retained and dead-lettered job payloads (universe and action IDs).',
    },
  ],
  async erase(scope) {
    const events = await transactionOf(scope)
      .deleteFrom('evidence.action_events')
      .where('universe_id', '=', scope.authority.universeId)
      .executeTakeFirst();
    const jobs = await deleteJobPayloads(scope, [applyActionEvidenceQueue.name]);
    return { module: 'evidence', status: 'completed', removed: Number(events.numDeletedRows) + jobs };
  },
};
