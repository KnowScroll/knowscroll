import { clearCoreTransactionOf } from '../../../infrastructure/postgres/privacy-scope.js';
import { sql } from 'kysely';
import { declareErasure } from '../../../infrastructure/erasure/declaration.js';
import { exportReading } from '../../../infrastructure/erasure/registry.js';
import { experienceExportRead } from './export.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
const tables = [
  'recording_channel_certificates',
  'recording_segment_inputs',
  'recording_segments',
  'recording_offer_origins',
  'recording_command_origins',
  'action_links',
  'action_state',
  'not_interested',
  'navigation_transitions',
  'offer_activations',
  'offer_region_constraints',
  'offers',
  'sessions',
  'encounter_activity_inputs',
  'encounter_lineage',
  'saved_places',
  'saved_items',
  'actions',
  'exposures',
] as const;
/** Saved items and places are the person's own library, so selective Clear keeps them. */
const keptByClear: readonly string[] = ['saved_items', 'saved_places'];
export const experienceErasure = declareErasure({
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
  clear: {
    defaultDisposition: 'erase',
    dispositions: Object.fromEntries(keptByClear.map((table) => [`experience.${table}`, 'preserve'])),
    async erase(scope) {
      let removed = 0;
      for (const table of tables.filter((candidate) => !keptByClear.includes(candidate))) {
        const result =
          await sql`delete from ${sql.table(`experience.${table}`)} where universe_id=${scope.binding.universeId}::uuid`.execute(
            clearCoreTransactionOf(scope),
          );
        removed += Number(result.numAffectedRows ?? 0);
      }
      return { module: 'experience', status: 'completed', removed };
    },
  },
  export: (declaration) =>
    exportReading(
      declaration,
      [
        'experience.saved_items',
        'experience.saved_places',
        'experience.exposures',
        'experience.actions',
        'experience.not_interested',
      ],
      'Navigation, offers, recorder certificates and activity inputs are internal bookkeeping behind the encounters and reactions listed; suggestions are not activity.',
      experienceExportRead,
    ),
});
