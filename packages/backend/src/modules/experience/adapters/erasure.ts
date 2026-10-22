import { clearCoreTransactionOf } from '../../../infrastructure/postgres/privacy-scope.js';
import { sql } from 'kysely';
import type { ModuleErasure } from '../../../infrastructure/erasure/registry.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
const tables = [
  'action_links',
  'action_state',
  'navigation_transitions',
  'offer_activations',
  'offers',
  'sessions',
  'encounter_activity_inputs',
  'encounter_lineage',
  'saved_places',
  'saved_items',
  'actions',
  'exposures',
] as const;
export const experienceErasure: ModuleErasure = {
  module: 'experience',
  tables: tables.map((table) => ({ schema: 'experience', table, ownerColumn: 'universe_id' })),
  nonRowStores: [],
  async erase(scope) {
    let removed = 0;
    for (const table of tables) {
      const result =
        await sql`delete from ${sql.table(`experience.${table}`)} where universe_id=${scope.authority.universeId}::uuid`.execute(
          transactionOf(scope),
        );
      removed += Number(result.numAffectedRows ?? 0);
    }
    return { module: 'experience', status: 'completed', removed };
  },
};

experienceErasure.clearExploration = {
  dispositions: Object.fromEntries([
    ...experienceErasure.tables.map((t) => [
      `${t.schema}.${t.table}`,
      t.table === 'saved_items' || t.table === 'saved_places' ? 'preserve' : 'erase',
    ]),
    ...experienceErasure.nonRowStores.map((s) => [`store:${s.name}`, 'erase']),
  ]) as Record<string, 'erase' | 'preserve'>,
  async erase(scope) {
    let removed = 0;
    for (const table of tables.filter((t) => t !== 'saved_items' && t !== 'saved_places')) {
      const result =
        await sql`delete from ${sql.table(`experience.${table}`)} where universe_id=${scope.binding.universeId}::uuid`.execute(
          clearCoreTransactionOf(scope),
        );
      removed += Number(result.numAffectedRows ?? 0);
    }
    return { module: 'experience', status: 'completed', removed };
  },
};
