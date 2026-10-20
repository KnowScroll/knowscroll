import type { ModuleErasure } from '../../../infrastructure/erasure/registry.js';
import { deleteJobPayloads } from '../../../infrastructure/jobs/erasure.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { applyActionEvidenceQueue, projectScrollReadingQueue } from '../events.js';

/** Evidence's personal tables, its queue payloads, and their eraser (blueprint §5). */
export const evidenceErasure: ModuleErasure = {
  module: 'evidence',
  // Dependants first: evidence revisions rest on observations, which rest on nothing erased here.
  tables: [
    { schema: 'evidence', table: 'encounter_evidence', ownerColumn: 'universe_id' },
    { schema: 'evidence', table: 'observations', ownerColumn: 'universe_id' },
    { schema: 'evidence', table: 'action_events', ownerColumn: 'universe_id' },
  ],
  nonRowStores: [
    {
      name: `pgboss/${applyActionEvidenceQueue.name}`,
      description: 'Queued, active, retained and dead-lettered job payloads (universe and action IDs).',
    },
    {
      name: `pgboss/${projectScrollReadingQueue.name}`,
      description: 'Queued, active, retained and dead-lettered job payloads (universe and exposure IDs).',
    },
  ],
  async erase(scope) {
    const trx = transactionOf(scope);
    const universeId = scope.authority.universeId;
    const evidence = await trx
      .deleteFrom('evidence.encounter_evidence')
      .where('universe_id', '=', universeId)
      .executeTakeFirst();
    const observations = await trx
      .deleteFrom('evidence.observations')
      .where('universe_id', '=', universeId)
      .executeTakeFirst();
    const events = await trx
      .deleteFrom('evidence.action_events')
      .where('universe_id', '=', universeId)
      .executeTakeFirst();
    const jobs = await deleteJobPayloads(scope, [applyActionEvidenceQueue.name, projectScrollReadingQueue.name]);
    return {
      module: 'evidence',
      status: 'completed',
      removed: Number(evidence.numDeletedRows + observations.numDeletedRows + events.numDeletedRows) + jobs,
    };
  },
};
