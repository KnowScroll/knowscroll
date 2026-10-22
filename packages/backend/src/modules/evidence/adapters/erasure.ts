import { clearCoreTransactionOf } from '../../../infrastructure/postgres/privacy-scope.js';
import { sql } from 'kysely';
import type { ModuleErasure } from '../../../infrastructure/erasure/registry.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { applyActionEvidenceQueue, projectScrollReadingQueue, projectEncounterActivityQueue } from '../events.js';
import { deleteJobPayloads, deleteClearJobPayloads } from '../../../infrastructure/jobs/erasure.js';
const queues = [applyActionEvidenceQueue, projectScrollReadingQueue, projectEncounterActivityQueue];
const tables = [
  'topic_contributions',
  'activity_current',
  'activity_revisions',
  'topic_context',
  'encounter_evidence',
  'observations',
  'action_events',
] as const;
export const evidenceErasure: ModuleErasure = {
  module: 'evidence',
  tables: tables.map((table) => ({ schema: 'evidence', table, ownerColumn: 'universe_id' })),
  nonRowStores: queues.map((queue) => ({
    name: `pgboss/${queue.name}`,
    description: 'Queued, active, retained and dead-lettered IDs-only jobs for this scope.',
  })),
  async erase(scope) {
    let removed = 0;
    for (const table of tables) {
      const result =
        await sql`delete from ${sql.table(`evidence.${table}`)} where universe_id=${scope.authority.universeId}::uuid`.execute(
          transactionOf(scope),
        );
      removed += Number(result.numAffectedRows ?? 0);
    }
    removed += await deleteJobPayloads(
      scope,
      queues.map((queue) => queue.name),
    );
    return { module: 'evidence', status: 'completed', removed };
  },
};

evidenceErasure.clearExploration = {
  dispositions: Object.fromEntries([
    ...evidenceErasure.tables.map((t) => [`${t.schema}.${t.table}`, 'erase']),
    ...evidenceErasure.nonRowStores.map((s) => [`store:${s.name}`, 'erase']),
  ]) as Record<string, 'erase' | 'preserve'>,
  async erase(scope) {
    let removed = 0;
    for (const table of tables) {
      const result =
        await sql`delete from ${sql.table(`evidence.${table}`)} where universe_id=${scope.binding.universeId}::uuid`.execute(
          clearCoreTransactionOf(scope),
        );
      removed += Number(result.numAffectedRows ?? 0);
    }
    removed += await deleteClearJobPayloads(
      scope,
      queues.map((queue) => queue.name),
    );
    return { module: 'evidence', status: 'completed', removed };
  },
};
