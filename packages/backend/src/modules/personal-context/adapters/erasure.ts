import { clearCoreTransactionOf } from '../../../infrastructure/postgres/privacy-scope.js';
import { sql } from 'kysely';
import { declareErasure } from '../../../infrastructure/erasure/declaration.js';
import { exportNothing } from '../../../infrastructure/erasure/registry.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
const tables = [
  'recording_coverage_references',
  'recording_coverage_contributions',
  'recording_exposure_contributions',
  'recording_segment_heads',
  'coverage_references',
  'coverage_supports',
  'coverage_contributions',
  'contributions',
  'supports',
  'topics',
  'state',
] as const;
export const personalContextErasure = declareErasure({
  module: 'personal-context',
  tables: tables.map((table) => ({ schema: 'personal_context', table, ownerColumn: 'universe_id' })),
  nonRowStores: [],
  async erase(scope) {
    let removed = 0;
    for (const table of tables) {
      const result =
        await sql`delete from ${sql.table(`personal_context.${table}`)} where universe_id=${scope.authority.universeId}::uuid`.execute(
          transactionOf(scope),
        );
      removed += Number(result.numAffectedRows ?? 0);
    }
    return { module: 'personal-context', status: 'completed', removed };
  },
  clear: {
    defaultDisposition: 'erase',
    async erase(scope) {
      let removed = 0;
      for (const table of tables) {
        const result =
          await sql`delete from ${sql.table(`personal_context.${table}`)} where universe_id=${scope.binding.universeId}::uuid`.execute(
            clearCoreTransactionOf(scope),
          );
        removed += Number(result.numAffectedRows ?? 0);
      }
      return { module: 'personal-context', status: 'completed', removed };
    },
  },
  export: (declaration) =>
    exportNothing(
      declaration,
      'Interest projections and coverage counts derived from your activity: internal scores that are never shown.',
    ),
});
